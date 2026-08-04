/**
 * 微信 iLink 消息处理器。
 *
 * Each WeChat user gets an isolated session with persistent history.
 * Long-running requests push event-driven progress to the user.
 */
import { sessions, type QueuedMessage } from "./session-store"
import {
  askMimo,
  type MimoPermissionRule,
} from "./mimo-integration"
import { AccessStore, SAFE_USER_TOOLS } from "./access-store"
import { splitChainedCommand } from "./command-utils"
import { extractOutgoingAttachments } from "./ilink-media"
import { ILinkClient } from "./ilink-client"
import { ProgressDebouncer } from "./progress-debouncer"
import { Hono } from "hono"

const app = new Hono()
const ilink = new ILinkClient()
const PROGRESS_DEBOUNCE_MS = parseInt(process.env.WECHAT_PROGRESS_DEBOUNCE_MS ?? "15000", 10)
const DELIVERY_RETRY_DELAY_MS = parseInt(process.env.WECHAT_DELIVERY_RETRY_DELAY_MS ?? "30000", 10)
const TYPING_REFRESH_MS = 20_000
const DEFAULT_PROVIDER_ID = process.env.MIMO_PROVIDER_ID ?? "deepseek"
const DEFAULT_MODEL_ID = process.env.MIMO_MODEL_ID ?? "deepseek-v4-flash"
const FALLBACK_CONTEXT_LIMIT_TOKENS = parseInt(process.env.MIMO_CONTEXT_LIMIT_TOKENS ?? "1000000", 10)
const CONFIGURED_ADMIN_USER_ID = process.env.WECHAT_ADMIN_USER_ID?.trim()

type MimoModel = {
  providerID?: string
  modelID?: string
}

function usersByCreationTime(): string[] {
  return sessions.listUsers()
    .map((userId) => ({
      userId,
      createdAt: sessions.stats(userId)?.createdAt ?? "",
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((item) => item.userId)
}

const access = new AccessStore(usersByCreationTime(), CONFIGURED_ADMIN_USER_ID)

/**
 * 普通用户默认拒绝全部工具，仅允许文件工具访问自己的工作目录。
 * Shell、Skill 和子代理保持拒绝，避免通过间接工具绕过目录白名单。
 */
function permissionsForUser(
  userId: string,
  cwd: string,
): MimoPermissionRule[] {
  const userAccess = access.get(userId)
  if (userAccess.role === "admin") {
    return [{
      permission: "*",
      pattern: "*",
      action: "allow",
    }]
  }
  const rules: MimoPermissionRule[] = [{
    permission: "*",
    pattern: "*",
    action: "deny",
  }]
  const paths = [...new Set([cwd, ...userAccess.paths])]
  for (const permission of userAccess.tools) {
    for (const path of paths) {
      rules.push(
        { permission, pattern: path, action: "allow" },
        { permission, pattern: `${path}/**`, action: "allow" },
      )
    }
  }
  rules.push({
    permission: "question",
    pattern: "*",
    action: "allow",
  })
  return rules
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
const deliveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

/** 最终回复必须获得微信业务成功回执，否则由持久化队列稍后重试。 */
async function sendWeChatRequired(to: string, text: string, deliveryId: string): Promise<void> {
  await ilink.sendText(to, text, deliveryId)
  console.log(`[send] confirmed to=${to} delivery=${deliveryId}`)
}

async function sendTyping(to: string, status: "start" | "stop") {
  try {
    await ilink.sendTyping(to, status === "start")
  } catch (err) {
    console.log(`[typing] failed to ${to}: ${err}`)
  }
}

async function sendWeChatMediaRequired(
  to: string,
  filePath: string,
  deliveryId: string,
): Promise<string | null> {
  try {
    await ilink.sendMedia(to, filePath, deliveryId)
    return null
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.log(`[send-media] failed to=${to} file=${filePath} delivery=${deliveryId}: ${detail}`)
    return `${filePath}：${detail}`
  }
}

// ─── Commands ─────────────────────────────────────────────────
const USER_HELP = `## 可用命令

- \`/help\`：查看可用命令
- \`/stop\`：中断当前回复并清空队列
- \`/clear\`：清空历史，下次消息开启新会话
- \`/stats\`：查看会话统计
- \`/compact\`：压缩当前长期会话

命令后可直接追加下一条要求，例如：\`/stop 检查最新日志\``

const ADMIN_HELP = `## 管理员命令

### 用户管理

- \`/users\`：查看用户和角色
- \`/role <用户ID> admin|user\`：设置角色
- \`/permissions <用户ID>\`：查看权限

### 工具权限

- \`/allow-tool <用户ID> <工具>\`：允许工具
- \`/deny-tool <用户ID> <工具>\`：禁用工具

可设置：${SAFE_USER_TOOLS.map((tool) => `\`${tool}\``).join("、")}

### 路径权限

- \`/allow-path <用户ID> <绝对路径>\`：允许访问
- \`/deny-path <用户ID> <绝对路径>\`：移除权限`

function stopUserWork(userId: string): number {
  const active = activeTasks.get(userId)
  if (active) active.abort()
  const total = pendingQueues.get(userId)?.length ?? 0
  const dropped = Math.max(0, total - (active ? 1 : 0))
  clearQueue(userId)
  return dropped
}

function knownUser(userId: string): boolean {
  return access.list().some((item) => item.userId === userId)
}

function formatPermissions(userId: string): string {
  const userAccess = access.get(userId)
  if (userAccess.role === "admin") {
    return [
      "【提示】用户权限",
      `- 用户：${userId}`,
      "- 角色：管理员",
      "- 权限：全部",
    ].join("\n")
  }
  return [
    "【提示】用户权限",
    `- 用户：${userId}`,
    "- 角色：普通用户",
    `- 工具：${userAccess.tools.length ? userAccess.tools.join("、") : "无"}`,
    `- 固定路径：${sessions.userPath(userId)}`,
    `- 附加路径：${userAccess.paths.length ? userAccess.paths.join("、") : "无"}`,
  ].join("\n")
}

function handleCommand(userId: string, text: string): string | null {
  const cmd = text.trim().toLowerCase()
  access.ensureUser(userId)
  if (cmd === "/help") {
    return USER_HELP + (
      access.isAdmin(userId)
        ? "\n- `/admin-help`：查看管理员命令"
        : ""
    )
  }
  if (cmd === "/admin-help") {
    return access.isAdmin(userId)
      ? ADMIN_HELP
      : "【提示】只有管理员可以查看管理员命令"
  }

  if (cmd === "/stop") {
    const active = activeTasks.get(userId)
    if (active) active.abort()
    const total = pendingQueues.get(userId)?.length ?? 0
    const dropped = Math.max(0, total - (active ? 1 : 0))
    clearQueue(userId)
    return active ? `【提示】当前对话已中断，长期会话已保留${dropped ? `，已清空 ${dropped} 条排队消息` : ""}` : "【提示】当前没有正在处理的对话，长期会话已保留"
  }

  if (cmd === "/clear") {
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

  if (cmd === "/users") {
    if (!access.isAdmin(userId)) return "【提示】只有管理员可以查看用户列表"
    return [
      "【提示】用户列表",
      ...access.list().map((item, index) =>
        `${index + 1}. ${item.access.role === "admin" ? "管理员" : "普通用户"}\n   ${item.userId}`
      ),
    ].join("\n")
  }

  const permissionsMatch = text.trim().match(/^\/permissions(?:\s+(\S+))?$/i)
  if (permissionsMatch) {
    const target = permissionsMatch[1] ?? userId
    if (target !== userId && !access.isAdmin(userId)) {
      return "【提示】只有管理员可以查看其他用户的权限"
    }
    if (!knownUser(target)) return "【提示】用户不存在，请先发送 /users 查看用户ID"
    return formatPermissions(target)
  }

  const roleMatch = text.trim().match(/^\/role\s+(\S+)\s+(admin|user)$/i)
  if (roleMatch) {
    if (!access.isAdmin(userId)) return "【提示】只有管理员可以设置角色"
    const target = roleMatch[1]
    const roleValue = roleMatch[2]
    if (!target || !roleValue) return "【提示】命令格式不正确，发送 /admin-help 查看用法"
    if (!knownUser(target)) return "【提示】用户不存在，请先发送 /users 查看用户ID"
    const role = roleValue.toLowerCase() as "admin" | "user"
    const changed = access.setRole(target, role)
    if (!changed.ok) return `【提示】设置失败：${changed.error}`
    const dropped = stopUserWork(target)
    return `【提示】已将 ${target} 设置为${role === "admin" ? "管理员" : "普通用户"}${dropped ? `，并清空 ${dropped} 条排队消息` : ""}`
  }

  const toolMatch = text.trim().match(/^\/(allow-tool|deny-tool)\s+(\S+)\s+(\S+)$/i)
  if (toolMatch) {
    if (!access.isAdmin(userId)) return "【提示】只有管理员可以设置工具权限"
    const operation = toolMatch[1]
    const target = toolMatch[2]
    const toolValue = toolMatch[3]
    if (!operation || !target || !toolValue) return "【提示】命令格式不正确，发送 /admin-help 查看用法"
    const tool = toolValue.toLowerCase()
    if (!knownUser(target)) return "【提示】用户不存在，请先发送 /users 查看用户ID"
    if (!AccessStore.isSafeTool(tool)) {
      return `【提示】不支持的工具，可设置：${SAFE_USER_TOOLS.join("、")}`
    }
    const allowed = operation.toLowerCase() === "allow-tool"
    access.setTool(target, tool, allowed)
    const dropped = stopUserWork(target)
    return `【提示】已${allowed ? "允许" : "禁用"} ${target} 的 ${tool} 工具${dropped ? `，并清空 ${dropped} 条排队消息` : ""}`
  }

  const pathMatch = text.trim().match(/^\/(allow-path|deny-path)\s+(\S+)\s+(.+)$/i)
  if (pathMatch) {
    if (!access.isAdmin(userId)) return "【提示】只有管理员可以设置路径权限"
    const operation = pathMatch[1]
    const target = pathMatch[2]
    const pathValue = pathMatch[3]
    if (!operation || !target || !pathValue) return "【提示】命令格式不正确，发送 /admin-help 查看用法"
    if (!knownUser(target)) return "【提示】用户不存在，请先发送 /users 查看用户ID"
    const allowed = operation.toLowerCase() === "allow-path"
    try {
      const path = access.setPath(target, pathValue, allowed)
      const dropped = stopUserWork(target)
      return `【提示】已${allowed ? "允许访问" : "移除路径"} ${path}${dropped ? `，并清空 ${dropped} 条排队消息` : ""}`
    } catch (error) {
      return `【提示】设置失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (/^\/(role|permissions|allow-tool|deny-tool|allow-path|deny-path)\b/i.test(text.trim())) {
    return "【提示】命令格式不正确，发送 /admin-help 查看用法"
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
  const retryTimer = deliveryRetryTimers.get(userId)
  if (retryTimer) clearTimeout(retryTimer)
  deliveryRetryTimers.delete(userId)
  const queue = pendingQueues.get(userId)
  if (!queue) return
  const remaining = queue.filter((item) => item.id !== messageId)
  if (remaining.length) pendingQueues.set(userId, remaining)
  else pendingQueues.delete(userId)
  sessions.saveQueue(userId, remaining)
}

function persistQueue(userId: string): void {
  sessions.saveQueue(userId, pendingQueues.get(userId) ?? [])
}

function scheduleDeliveryRetry(userId: string): void {
  if (deliveryRetryTimers.has(userId)) return
  const timer = setTimeout(() => {
    deliveryRetryTimers.delete(userId)
    runNextMessage(userId)
  }, DELIVERY_RETRY_DELAY_MS)
  deliveryRetryTimers.set(userId, timer)
  console.log(`[send] final reply queued for retry user=${userId} delay=${DELIVERY_RETRY_DELAY_MS}ms`)
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
  const retryTimer = deliveryRetryTimers.get(userId)
  if (retryTimer) clearTimeout(retryTimer)
  deliveryRetryTimers.delete(userId)
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
async function deliverPendingReply(from: string, queuedMessage: QueuedMessage): Promise<void> {
  const pending = queuedMessage.pendingReply
  if (!pending) return

  await sendWeChatRequired(from, pending.text, pending.deliveryId)
  if (!pending.historyRecorded) {
    sessions.addMessage(from, "assistant", pending.text)
    pending.historyRecorded = true
    persistQueue(from)
  }

  const mediaErrors: string[] = []
  for (let index = pending.nextFileIndex; index < pending.files.length; index++) {
    const filePath = pending.files[index]
    if (!filePath) continue
    const error = await sendWeChatMediaRequired(from, filePath, `${pending.deliveryId}-media-${index}`)
    if (error) mediaErrors.push(error)
    pending.nextFileIndex = index + 1
    persistQueue(from)
  }

  const notices = [pending.mediaNotice, ...mediaErrors].filter(Boolean)
  if (notices.length) {
    await sendWeChatRequired(
      from,
      `【提示】部分附件未能发送：\n${notices.map((error) => `- ${error}`).join("\n")}`,
      `${pending.deliveryId}-media-notice`,
    )
  }
  queuedMessage.pendingReply = undefined
  persistQueue(from)
}

async function processMessage(from: string, queuedMessage: QueuedMessage, mimoSessionId: string | undefined) {
  if (activeTasks.has(from)) {
    await sendWeChat(from, "【提示】上一条还在处理。发送 /stop 以中断。")
    return
  }

  const text = queuedMessage.text
  const startedAt = Date.now()
  const abort = new AbortController()
  activeTasks.set(from, abort)

  // 服务重启或投递失败后只重发最终回复，不重新执行可能带副作用的 MiMoCode 任务。
  if (queuedMessage.pendingReply) {
    let delivered = false
    try {
      await deliverPendingReply(from, queuedMessage)
      delivered = true
    } catch (error) {
      console.log(`[send] final delivery failed user=${from}: ${error}`)
      scheduleDeliveryRetry(from)
    } finally {
      activeTasks.delete(from)
    }
    if (delivered) {
      completeMessage(from, queuedMessage.id)
      runNextMessage(from)
    }
    return
  }

  if (markMessageStarted(from, queuedMessage.id)) {
    sessions.addMessage(from, "user", text)
  }
  const progress = new ProgressDebouncer(PROGRESS_DEBOUNCE_MS, async (merged) => {
    if (abort.signal.aborted) return
    await sendWeChat(from, `【进度】\n\n${merged}`)
  })

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
    const permission = permissionsForUser(from, cwd)
    let result = await askMimo(
      mimoSessionId,
      text,
      cwd,
      abort.signal,
      undefined,
      (update) => progress.push(update.delta),
      permission,
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
        (update) => progress.push(update.delta),
        permission,
      )
    }

    // 最终结果优先：取消计时并丢弃尚未投递的进度消息。
    await progress.discardAndWait()
    if (abort.signal.aborted) return

    const elapsedMs = Date.now() - startedAt
    if (result.success) {
      if (result.sessionId && result.sessionId !== mimoSessionId) {
        const cfg = sessions.getConfig(from)
        sessions.saveConfig(from, { ...cfg, metadata: { ...cfg.metadata, mimoSessionId: result.sessionId } })
      }
      if (result.tokens) console.log(`[mimo] user=${from} tokens=${result.tokens.total}`)
      const outgoing = await extractOutgoingAttachments(result.text, cwd)
      const reply = `${outgoing.text}\n\n${buildReplyMeta(elapsedMs, result.tokens, result.model)}`
      queuedMessage.pendingReply = {
        text: reply,
        deliveryId: crypto.randomUUID(),
        files: outgoing.files,
        nextFileIndex: 0,
        mediaNotice: outgoing.rejected.length ? outgoing.rejected.join("\n- ") : undefined,
      }
    } else {
      console.log(`[mimo] FAILED user=${from} error=${result.error} elapsed=${elapsedMs}ms`)
      queuedMessage.pendingReply = {
        text: formatErrorMessage(result.error, elapsedMs, result.tokens, result.model),
        deliveryId: crypto.randomUUID(),
        files: [],
        nextFileIndex: 0,
      }
    }
    // 先持久化再发送，进程中断后仍能仅重发最终回复。
    persistQueue(from)
    await deliverPendingReply(from, queuedMessage)
  } finally {
    await progress.discardAndWait()
    clearTimeout(typingRetryTimer)
    clearInterval(typingInterval)
    await sendTyping(from, "stop")
    activeTasks.delete(from)
    if (abort.signal.aborted) {
      completeMessage(from, queuedMessage.id)
      runNextMessage(from)
    } else if (queuedMessage.pendingReply) {
      scheduleDeliveryRetry(from)
    } else {
      completeMessage(from, queuedMessage.id)
      runNextMessage(from)
    }
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

  const chained = splitChainedCommand(text)
  if (chained?.command === "/compact") {
    enqueueMessage(from, chained.command)
    enqueueMessage(from, chained.followUp)
    runNextMessage(from)
    return
  }

  const commandText = chained?.command ?? text
  const cmdReply = handleCommand(from, commandText)
  if (cmdReply !== null) {
    await sendWeChat(from, cmdReply)
    if (chained) {
      enqueueMessage(from, chained.followUp)
      runNextMessage(from)
    }
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
  await ilink.start(
    async ({ from, text }) => handleInbound(from, text),
    (userId) => sessions.userPath(userId),
  )
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
