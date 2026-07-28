/**
 * Bot handler — webhook endpoint for weixin-clawbot-bridge.
 *
 * Each WeChat user gets an isolated session with persistent history.
 * Long-running requests send interim "processing" status to the user.
 */
import { sessions } from "./session-store"
import { askMimo } from "./mimo-integration"
import { Hono } from "hono"

const app = new Hono()
const BRIDGE_API = "http://127.0.0.1:3200"
const PROGRESS_DELAY_MS = 1_800_000
const PROGRESS_INTERVAL_MS = 1_800_000
const PROGRESS_PREVIEW_CHARS = 500
const PROGRESS_MIN_DELTA_CHARS = 80
const TYPING_REFRESH_MS = 20_000
const DEFAULT_PROVIDER_ID = process.env.MIMO_PROVIDER_ID ?? "deepseek"
const DEFAULT_MODEL_ID = process.env.MIMO_MODEL_ID ?? "deepseek-v4-flash"
const FALLBACK_CONTEXT_LIMIT_TOKENS = parseInt(process.env.MIMO_CONTEXT_LIMIT_TOKENS ?? "1000000", 10)

type QueuedMessage = {
  text: string
  receivedAt: number
}

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
    parts.push(`I ${formatTokenCount(tokens.input)} / O ${formatTokenCount(tokens.output)}`)
    parts.push(`${formatTokenCount(tokens.total)} / ${formatTokenCount(contextLimit)}(${percent}%)`)
  }
  return parts.join("｜")
}

function compactPreview(text: string): string {
  const compact = text.trim()
  if (compact.length <= PROGRESS_PREVIEW_CHARS) return compact
  return `...${compact.slice(-PROGRESS_PREVIEW_CHARS)}`
}

function progressDelta(text: string, sentLength: number): string {
  const compact = text.trim()
  if (compact.length <= sentLength) return ""
  return compact.slice(sentLength).trim()
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
    const res = await fetch(`${BRIDGE_API}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, text }),
    })
    if (!res.ok) console.log(`[send] HTTP ${res.status} for ${to}`)
  } catch (err) {
    console.log(`[send] failed to ${to}: ${err}`)
  }
}

async function sendTyping(to: string, status: "start" | "stop") {
  try {
    const res = await fetch(`${BRIDGE_API}/api/typing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, status }),
    })
    if (!res.ok) console.log(`[typing] HTTP ${res.status} for ${to} status=${status}`)
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
/compact 发送 /compact 给 MiMoCode，让它压缩当前长期会话`

function handleCommand(userId: string, text: string): string | null {
  const cmd = text.trim().toLowerCase()
  if (cmd === "/help") return HELP

  if (cmd === "/stop") {
    const active = activeTasks.get(userId)
    if (active) active.abort()
    const dropped = pendingQueues.get(userId)?.length ?? 0
    pendingQueues.delete(userId)
    return active ? `【提示】当前对话已中断，长期会话已保留${dropped ? `，已清空 ${dropped} 条排队消息` : ""}` : "【提示】当前没有正在处理的对话，长期会话已保留"
  }

  if (cmd === "/clear") {
    const active = activeTasks.get(userId)
    if (active) active.abort()
    pendingQueues.delete(userId)
    sessions.clear(userId)
    const cfg = sessions.getConfig(userId)
    sessions.saveConfig(userId, { ...cfg, metadata: { ...cfg.metadata, mimoSessionId: undefined } })
    return "【提示】会话历史已清除，下次消息将开启新会话"
  }

  if (cmd === "/stats") {
    const s = sessions.stats(userId)
    const queued = pendingQueues.get(userId)?.length ?? 0
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
  queue.push({ text, receivedAt: Date.now() })
  return queue.length
}

function shiftMessage(userId: string): QueuedMessage | undefined {
  const queue = pendingQueues.get(userId)
  if (!queue) return undefined
  const next = queue.shift()
  if (!queue.length) pendingQueues.delete(userId)
  return next
}

function runNextMessage(userId: string): void {
  if (activeTasks.has(userId)) return
  const next = shiftMessage(userId)
  if (!next) return
  const config = sessions.getConfig(userId)
  const mimoSessionId = config.metadata?.mimoSessionId as string | undefined
  processMessage(userId, next.text, mimoSessionId).catch((err) => console.log(`[process] error: ${err}`))
}

// ─── Async processing ─────────────────────────────────────────
async function processMessage(from: string, text: string, mimoSessionId: string | undefined) {
  if (activeTasks.has(from)) {
    await sendWeChat(from, "【提示】上一条还在处理。发送 /stop 以中断。")
    return
  }

  const startedAt = Date.now()
  const abort = new AbortController()
  activeTasks.set(from, abort)
  sessions.addMessage(from, "user", text)
  let latestProgressText = ""
  let lastProgressLength = 0
  let progressInterval: ReturnType<typeof setInterval> | undefined
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

  const sendProgress = async () => {
    if (abort.signal.aborted) return
    const elapsed = formatDuration(Date.now() - startedAt)
    if (latestProgressText && latestProgressText.length > lastProgressLength) {
      const delta = progressDelta(latestProgressText, lastProgressLength)
      lastProgressLength = latestProgressText.trim().length
      if (delta.length >= PROGRESS_MIN_DELTA_CHARS) {
        await sendWeChat(from, `【提示】处理中（已耗时 ${elapsed}）：\n\n${compactPreview(delta)}\n\n发送 /stop 以中断。`)
      }
      return
    }
    await sendWeChat(from, `【提示】还在处理中，已耗时 ${elapsed}。发送 /stop 以中断。`)
  }

  const progressTimer = setTimeout(() => {
    sendProgress().catch((err) => console.log(`[progress] error: ${err}`))
    progressInterval = setInterval(() => {
      sendProgress().catch((err) => console.log(`[progress] error: ${err}`))
    }, PROGRESS_INTERVAL_MS)
  }, PROGRESS_DELAY_MS)

  try {
    const cwd = sessions.userPath(from)
    let result = await askMimo(mimoSessionId, text, cwd, abort.signal, undefined, (progress) => {
      if (progress.text) latestProgressText = progress.text
    })

    // Retry if session expired
    if (!result.success && result.error === "no text response" && mimoSessionId) {
      console.log(`[mimo] session expired for ${from}`)
      mimoSessionId = undefined
      const cfg = sessions.getConfig(from)
      sessions.saveConfig(from, { ...cfg, metadata: { ...cfg.metadata, mimoSessionId: undefined } })
      result = await askMimo(undefined, text, cwd, abort.signal, undefined, (progress) => {
        if (progress.text) latestProgressText = progress.text
      })
    }

    clearTimeout(progressTimer)
    if (progressInterval) clearInterval(progressInterval)
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
    clearTimeout(progressTimer)
    if (progressInterval) clearInterval(progressInterval)
    clearTimeout(typingRetryTimer)
    clearInterval(typingInterval)
    await sendTyping(from, "stop")
    activeTasks.delete(from)
    runNextMessage(from)
  }
}

// ─── Routes ───────────────────────────────────────────────────
app.post("/webhook", async (c) => {
  const body = await c.req.json<{ from?: string; content?: { type?: string; text?: string } }>()
  const from = body.from
  const content = body.content
  if (!from || !content) return c.json({ error: "missing from/content" }, 400)

  let text = ""
  if (content.type === "text" && content.text) text = content.text
  else if (content.type === "voice" && content.text) text = `[语音] ${content.text}`
  else text = `[${content.type}消息]`

  if (!checkRateLimit(from, text)) return c.json({ text: "⏳ 消息太快了" })

  if (isLocalNotice(text)) {
    return c.json({ text: "【提示】已收到本地提示，不会发送给 AI。" })
  }

  const cmdReply = handleCommand(from, text)
  if (cmdReply !== null) {
    return c.json({ text: cmdReply })
  }

  if (activeTasks.has(from)) {
    const queued = enqueueMessage(from, text)
    return c.json({ text: `【提示】已加入队列，前面还有 ${queued} 条待处理。发送 /stop 以中断并清空队列。` })
  }

  enqueueMessage(from, text)
  runNextMessage(from)

  return c.json({ ok: true })
})

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
  queues: [...pendingQueues.entries()].map(([userId, items]) => ({ userId, count: items.length })),
  count: activeTasks.size,
}))
app.get("/health", (c) => c.json({ status: "ok", uptime: process.uptime() }))

// ─── Start ────────────────────────────────────────────────────
const PORT = parseInt(process.env.BOT_PORT ?? "3000", 10)
console.log(`[bot-handler] starting on port ${PORT}`)

Bun.serve({ fetch: (req) => app.fetch(req), port: PORT })
console.log(`[bot-handler] listening at http://0.0.0.0:${PORT}`)
