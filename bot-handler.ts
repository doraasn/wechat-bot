/**
 * 微信 iLink 消息处理器。
 *
 * Each WeChat user gets an isolated session with persistent history.
 * Long-running requests push event-driven progress to the user.
 */
import { sessions, type QueuedMessage } from "./session-store"
import {
  askMimo,
  replyMimoPermission,
  type MimoPermissionRequest,
} from "./mimo-integration"
import { ILinkClient } from "./ilink-client"
import { Hono } from "hono"

const app = new Hono()
const ilink = new ILinkClient()
const PROGRESS_CHUNK_CHARS = 1_500
const TYPING_REFRESH_MS = 20_000
const DEFAULT_PROVIDER_ID = process.env.MIMO_PROVIDER_ID ?? "deepseek"
const DEFAULT_MODEL_ID = process.env.MIMO_MODEL_ID ?? "deepseek-v4-flash"
const FALLBACK_CONTEXT_LIMIT_TOKENS = parseInt(process.env.MIMO_CONTEXT_LIMIT_TOKENS ?? "1000000", 10)

type MimoModel = {
  providerID?: string
  modelID?: string
}

// ─── Rate limiter ─────────────────────────────────────────────
const RATE_WINDOW = 2000
const RATE_MAX = 5
const rateBuckets = new Map<string, number[]>()

function checkRateLimit(userId: string, text: string): boolean {
  if (text.trim().startsWith("/")) return true
  const now = Date.now()
  let bucket = rateBuckets.get(userId)
  if (!bucket) { bucket = []; rateBuckets.set(userId, bucket) }
  const recent = bucket.filter((t) => now - t < RATE_WINDOW)
  if (recent.length >= RATE_MAX) return false
  recent.push(now)
  rateBuckets.set(userId, recent)
  return true
}

// ─── Active tasks tracking ────────────────────────────────────
const activeTasks = new Map<string, AbortController>()
const pendingQueues = new Map<string, QueuedMessage[]>()
const APPROVAL_TIMEOUT_MS = 4 * 60_000

type PendingApproval = {
  request: MimoPermissionRequest
  cwd: string
  timer: ReturnType<typeof setTimeout>
}

const pendingApprovals = new Map<string, PendingApproval>()
for (const userId of sessions.listUsers()) {
  const queue = sessions.loadQueue(userId)
  if (queue.length) pendingQueues.set(userId, queue)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes} 分 ${rest} 秒`
}

function formatTimestamp(date = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-")
}

function formatLocalTime(value: string | number | Date): string {
  return formatTimestamp(new Date(value))
}

function formatCompactTimestamp(date = new Date()): string {
  const timestamp = formatTimestamp(date)
  return `${timestamp.slice(2, 4)}/${timestamp.slice(5, 7)}/${timestamp.slice(8)}`
}

function formatCompactDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${minutes}'${seconds}''`
  if (minutes > 0) return `${minutes}'${seconds}''`
  return `${seconds}''`
}

function resolveModel(model?: MimoModel): Required<MimoModel> {
  return {
    providerID: model?.providerID ?? DEFAULT_PROVIDER_ID,
    modelID: model?.modelID ?? DEFAULT_MODEL_ID,
  }
}

function contextLimitForModel(model?: MimoModel): number {
  const resolved = resolveModel(model)
  const key = `${resolved.providerID}/${resolved.modelID}`.toLowerCase()
  if (key.startsWith("deepseek/")) return 1_000_000
  return FALLBACK_CONTEXT_LIMIT_TOKENS
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`
  }
  return `${value}`
}

function compactModelName(model?: MimoModel): string {
  return resolveModel(model).modelID
}

function buildReplyMeta(elapsedMs: number, tokens?: { total: number; input: number; output: number }, model?: MimoModel): string {
  const parts = [
    formatCompactTimestamp(),
    formatCompactDuration(elapsedMs),
  ]
  if (tokens) {
    const contextLimit = contextLimitForModel(model)
    const percent = contextLimit > 0 ? ((tokens.total / contextLimit) * 100).toFixed(1) : "0.0"
    parts.push(`${formatTokenCount(tokens.total)}/${formatTokenCount(contextLimit)}(${percent}%)`)
  }
  return parts.join("｜")
}

function splitProgress(text: string): string[] {
  const compact = text.trim()
  if (!compact) return []
  const chunks: string[] = []
  for (let offset = 0; offset < compact.length; offset += PROGRESS_CHUNK_CHARS) {
    chunks.push(compact.slice(offset, offset + PROGRESS_CHUNK_CHARS))
  }
  return chunks
}

function formatErrorMessage(
  error: string | undefined,
  elapsedMs: number,
  tokens?: { total: number; input: number; output: number },
  model?: MimoModel,
): string {
  if (error === "timeout") {
    return `【提示】处理超时，已耗时 ${formatDuration(elapsedMs)}。发送 /stop 以中断，或发送 /compact 压缩上下文。\n\n${buildReplyMeta(elapsedMs, tokens, model)}`
  }
  return `【提示】处理出错：${error ?? "未知错误"}\n\n${buildReplyMeta(elapsedMs, tokens, model)}`
}

// ─── Bridge API: send message to WeChat user ──────────────────
async function sendWeChat(to: string, text: string) {
  try {
    await ilink.sendText(to, text)
  } catch (err) {
    console.log(`[send] failed to ${to}: ${err}`)
  }
}

async function sendTyping(to: string, status: "start" | "stop") {
  try {
    await ilink.sendTyping(to, status === "start")
  } catch (err) {
    console.log(`[typing] failed to ${to}: ${err}`)
  }
}

// ─── Commands ─────────────────────────────────────────────────
const HELP = `可用命令:
/help    查看所有可用命令
/stop    中断当前正在处理的回复，保留长期会话
/clear   清空当前用户历史，并在下次消息开启新会话
/stats   查看当前用户会话统计
/compact 发送 /compact 给 MiMoCode，让它压缩当前长期会话
/allow   批准当前高风险操作一次
/deny    拒绝当前高风险操作`

function redactApprovalDetail(value: string): string {
  return value
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[已隐藏 Token]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [已隐藏]")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1[已隐藏]")
}

async function registerApproval(
  userId: string,
  cwd: string,
  request: MimoPermissionRequest,
): Promise<void> {
  const current = pendingApprovals.get(userId)
  if (current?.request.id === request.id) return
  if (current) {
    clearTimeout(current.timer)
    await replyMimoPermission(current.request.id, current.cwd, "reject").catch(() => {})
  }

  const timer = setTimeout(() => {
    const pending = pendingApprovals.get(userId)
    if (pending?.request.id !== request.id) return
    pendingApprovals.delete(userId)
    void replyMimoPermission(request.id, cwd, "reject")
      .catch((error) => console.log(`[approval] timeout reject failed: ${error}`))
    activeTasks.get(userId)?.abort()
    void sendWeChat(userId, "【提示】授权请求已超时并自动拒绝，本次任务已中断。")
  }, APPROVAL_TIMEOUT_MS)
  pendingApprovals.set(userId, { request, cwd, timer })

  const targets = request.patterns.length
    ? request.patterns.map(redactApprovalDetail).join("\n")
    : "未提供目标"
  await sendWeChat(
    userId,
    [
      "【授权请求】",
      `操作：${request.permission}`,
      `目标：${targets.slice(0, 1200)}`,
      "",
      "回复 /allow 批准一次，或 /deny 拒绝。",
      "4 分钟未回复将自动拒绝。",
    ].join("\n"),
  )
}

async function answerApproval(userId: string, allow: boolean): Promise<void> {
  const pending = pendingApprovals.get(userId)
  if (!pending) {
    await sendWeChat(userId, "【提示】当前没有待处理的授权请求。")
    return
  }
  pendingApprovals.delete(userId)
  clearTimeout(pending.timer)
  try {
    await replyMimoPermission(
      pending.request.id,
      pending.cwd,
      allow ? "once" : "reject",
    )
    if (!allow) activeTasks.get(userId)?.abort()
    await sendWeChat(
      userId,
      allow ? "【提示】已批准本次操作。" : "【提示】已拒绝本次操作，本次任务已中断。",
    )
  } catch (error) {
    await sendWeChat(userId, `【提示】授权回复失败：${error}`)
  }
}

function rejectPendingApproval(userId: string): void {
  const pending = pendingApprovals.get(userId)
  if (!pending) return
  pendingApprovals.delete(userId)
  clearTimeout(pending.timer)
  void replyMimoPermission(pending.request.id, pending.cwd, "reject")
    .catch((error) => console.log(`[approval] reject failed: ${error}`))
}

function handleCommand(userId: string, text: string): string | null {
  const cmd = text.trim().toLowerCase()
  if (cmd === "/help") return HELP

  if (cmd === "/stop") {
    rejectPendingApproval(userId)
    const active = activeTasks.get(userId)
    if (active) active.abort()
    const total = pendingQueues.get(userId)?.length ?? 0
    const dropped = Math.max(0, total - (active ? 1 : 0))
    clearQueue(userId)
    return active ? `【提示】当前对话已中断，长期会话已保留${dropped ? `，已清空 ${dropped} 条排队消息` : ""}` : "【提示】当前没有正在处理的对话，长期会话已保留"
  }

  if (cmd === "/clear") {
    rejectPendingApproval(userId)
    const active = activeTasks.get(userId)
    if (active) active.abort()
    clearQueue(userId)
    sessions.clear(userId)
    const cfg = sessions.getConfig(userId)
    sessions.saveConfig(userId, { ...cfg, metadata: { ...cfg.metadata, mimoSessionId: undefined } })
    return "【提示】会话历史已清除，下次消息将开启新会话"
  }

  if (cmd === "/stats") {
    const s = sessions.stats(userId)
    const total = pendingQueues.get(userId)?.length ?? 0
    const queued = Math.max(0, total - (activeTasks.has(userId) ? 1 : 0))
    const running = activeTasks.has(userId) ? "是" : "否"
    return s
      ? [
          "【提示】会话统计",
          `- 消息数：${s.historyCount}`,
          `- 排队：${queued}`,
          `- 处理中：${running}`,
          `- 创建：${formatLocalTime(s.createdAt)}`,
          `- 更新：${formatLocalTime(s.updatedAt)}`,
        ].join("\n")
      : [
          "【提示】暂无数据",
          `- 排队：${queued}`,
          `- 处理中：${running}`,
        ].join("\n")
  }
  return null
}

function isLocalNotice(text: string): boolean {
  const value = text.trim()
  return value.startsWith("【提示】") || value.startsWith("[提示]")
}

function enqueueMessage(userId: string, text: string): number {
  let queue = pendingQueues.get(userId)
  if (!queue) {
    queue = []
    pendingQueues.set(userId, queue)
  }
  queue.push({ id: crypto.randomUUID(), text, receivedAt: Date.now() })
  sessions.saveQueue(userId, queue)
  return queue.length
}

function peekMessage(userId: string): QueuedMessage | undefined {
  return pendingQueues.get(userId)?.[0]
}

function completeMessage(userId: string, messageId: string): void {
  const queue = pendingQueues.get(userId)
  if (!queue) return
  const remaining = queue.filter((item) => item.id !== messageId)
  if (remaining.length) pendingQueues.set(userId, remaining)
  else pendingQueues.delete(userId)
  sessions.saveQueue(userId, remaining)
}

function markMessageStarted(userId: string, messageId: string): boolean {
  const queue = pendingQueues.get(userId)
  const item = queue?.find((candidate) => candidate.id === messageId)
  if (!queue || !item || item.startedAt) return false
  item.startedAt = Date.now()
  sessions.saveQueue(userId, queue)
  return true
}

function clearQueue(userId: string): void {
  pendingQueues.delete(userId)
  sessions.saveQueue(userId, [])
}

function runNextMessage(userId: string): void {
  if (activeTasks.has(userId)) return
  const next = peekMessage(userId)
  if (!next) return
  const config = sessions.getConfig(userId)
  const mimoSessionId = config.metadata?.mimoSessionId as string | undefined
  processMessage(userId, next, mimoSessionId).catch((err) => console.log(`[process] error: ${err}`))
}

// ─── Async processing ─────────────────────────────────────────
async function processMessage(from: string, queuedMessage: QueuedMessage, mimoSessionId: string | undefined) {
  if (activeTasks.has(from)) {
    await sendWeChat(from, "【提示】上一条还在处理。发送 /stop 以中断。")
    return
  }

  const text = queuedMessage.text
  const startedAt = Date.now()
  const abort = new AbortController()
  activeTasks.set(from, abort)
  if (markMessageStarted(from, queuedMessage.id)) {
    sessions.addMessage(from, "user", text)
  }
  let progressSendChain = Promise.resolve()

  const queueProgress = (delta?: string) => {
    if (!delta) return
    for (const chunk of splitProgress(delta)) {
      progressSendChain = progressSendChain
        .then(async () => {
          if (abort.signal.aborted) return
          await sendWeChat(from, `【进度】\n\n${chunk}`)
        })
        .catch((err) => console.log(`[progress] error: ${err}`))
    }
  }

  await sendTyping(from, "start")
  const typingRetryTimer = setTimeout(() => {
    if (!abort.signal.aborted) {
      sendTyping(from, "start").catch((err) => console.log(`[typing] retry error: ${err}`))
    }
  }, 1500)
  const typingInterval = setInterval(() => {
    if (!abort.signal.aborted) {
      sendTyping(from, "start").catch((err) => console.log(`[typing] refresh error: ${err}`))
    }
  }, TYPING_REFRESH_MS)

  try {
    const cwd = sessions.userPath(from)
    const onPermission = (request: MimoPermissionRequest) =>
      registerApproval(from, cwd, request)
    let result = await askMimo(
      mimoSessionId,
      text,
      cwd,
      abort.signal,
      undefined,
      (progress) => queueProgress(progress.delta),
      onPermission,
    )

    // Retry if session expired
    if (!result.success && result.error === "no text response" && mimoSessionId) {
      console.log(`[mimo] session expired for ${from}`)
      mimoSessionId = undefined
      const cfg = sessions.getConfig(from)
      sessions.saveConfig(from, { ...cfg, metadata: { ...cfg.metadata, mimoSessionId: undefined } })
      result = await askMimo(
        undefined,
        text,
        cwd,
        abort.signal,
        undefined,
        (progress) => queueProgress(progress.delta),
        onPermission,
      )
    }

    await progressSendChain
    if (abort.signal.aborted) return

    if (result.success) {
      const elapsedMs = Date.now() - startedAt
      if (result.sessionId && result.sessionId !== mimoSessionId) {
        const cfg = sessions.getConfig(from)
        sessions.saveConfig(from, { ...cfg, metadata: { ...cfg.metadata, mimoSessionId: result.sessionId } })
      }
      if (result.tokens) console.log(`[mimo] user=${from} tokens=${result.tokens.total}`)
      const reply = `${result.text}\n\n${buildReplyMeta(elapsedMs, result.tokens, result.model)}`
      sessions.addMessage(from, "assistant", reply)
      await sendWeChat(from, reply)
    } else {
      const elapsedMs = Date.now() - startedAt
      console.log(`[mimo] FAILED user=${from} error=${result.error} elapsed=${elapsedMs}ms`)
      await sendWeChat(from, formatErrorMessage(result.error, elapsedMs, result.tokens, result.model))
    }
  } finally {
    await progressSendChain
    clearTimeout(typingRetryTimer)
    clearInterval(typingInterval)
    await sendTyping(from, "stop")
    activeTasks.delete(from)
    completeMessage(from, queuedMessage.id)
    runNextMessage(from)
  }
}

// ─── iLink inbound ────────────────────────────────────────────
async function handleInbound(from: string, text: string): Promise<void> {
  if (!checkRateLimit(from, text)) {
    await sendWeChat(from, "⏳ 消息太快了")
    return
  }

  if (isLocalNotice(text)) {
    await sendWeChat(from, "【提示】已收到本地提示，不会发送给 AI。")
    return
  }

  const approvalCommand = text.trim().toLowerCase()
  if (approvalCommand === "/allow" || approvalCommand === "/deny") {
    await answerApproval(from, approvalCommand === "/allow")
    return
  }

  const cmdReply = handleCommand(from, text)
  if (cmdReply !== null) {
    await sendWeChat(from, cmdReply)
    return
  }

  if (activeTasks.has(from)) {
    const queued = enqueueMessage(from, text)
    await sendWeChat(
      from,
      `【提示】已加入队列，前面还有 ${Math.max(1, queued - 1)} 条待处理。发送 /stop 以中断并清空队列。`,
    )
    return
  }

  enqueueMessage(from, text)
  runNextMessage(from)
}

// Session management
app.get("/session/:userId", (c) => {
  const s = sessions.stats(c.req.param("userId"))
  return s ? c.json(s) : c.json({ error: "not found" }, 404)
})

app.post("/session/:userId/clear", (c) => {
  sessions.clear(c.req.param("userId"))
  return c.json({ ok: true })
})

// Admin
app.get("/admin/users", (c) => c.json({ total: sessions.listUsers().length, users: sessions.listUsers().map((id) => ({ id, ...sessions.stats(id) })) }))
app.get("/admin/tasks", (c) => c.json({
  active: [...activeTasks.keys()],
  queues: [...pendingQueues.entries()].map(([userId, items]) => ({
    userId,
    count: Math.max(0, items.length - (activeTasks.has(userId) ? 1 : 0)),
  })),
  count: activeTasks.size,
}))
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }))
app.get("/ilink/status", (c) => c.json(ilink.status()))

// ─── Start ────────────────────────────────────────────────────
const PORT = parseInt(process.env.BOT_PORT ?? "3000", 10)
console.log(`[bot-handler] starting on port ${PORT}`)

Bun.serve({ fetch: (req) => app.fetch(req), port: PORT })
console.log(`[bot-handler] listening at http://0.0.0.0:${PORT}`)

/** iLink 就绪后恢复持久化队列。 */
void (async () => {
  await ilink.start(async ({ from, text }) => handleInbound(from, text))
  for (const userId of pendingQueues.keys()) runNextMessage(userId)
})().catch((error) => {
  console.error(`[ilink] startup failed: ${error}`)
  process.exit(1)
})

async function shutdown(): Promise<void> {
  await ilink.stop()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
