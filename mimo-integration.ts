import { mkdirSync } from "fs"
import { normalizeTrailingColon } from "./text-format"

export function resolveRequestTimeoutMs(value?: string): number {
  const configured = Number.parseInt(value ?? "0", 10)
  return Number.isFinite(configured) ? Math.max(0, configured) : 0
}

// 0 表示不限制处理时长，由微信用户通过 /stop 主动中断。
const DEFAULT_TIMEOUT_MS = resolveRequestTimeoutMs(
  process.env.MIMO_REQUEST_TIMEOUT_MS,
)
const ABORT_WAIT_MS = 5_000
const STATUS_POLL_MS = 100
const MIMO_SERVER_URL = process.env.MIMO_SERVER_URL ?? "http://127.0.0.1:4096"
const DEFAULT_PROVIDER_ID = process.env.MIMO_PROVIDER_ID ?? "deepseek"
const DEFAULT_MODEL_ID = process.env.MIMO_MODEL_ID ?? "deepseek-v4-flash"

export interface MimoResult {
  success: boolean
  text: string
  sessionId?: string
  error?: string
  model?: {
    providerID?: string
    modelID?: string
  }
  tokens?: {
    total: number
    input: number
    output: number
  }
}

export interface MimoProgress {
  text: string
  delta?: string
  sessionId?: string
  model?: MimoResult["model"]
  tokens?: MimoResult["tokens"]
}

export type MimoPermissionRule = {
  permission: string
  pattern: string
  action: "allow" | "ask" | "deny"
}

type ServerEvent = {
  type?: string
  properties?: {
    id?: string
    requestID?: string
    sessionID?: string
    error?: { message?: string } | string
    info?: {
      id?: string
      role?: string
      sessionID?: string
      providerID?: string
      modelID?: string
      tokens?: {
        total?: number
        input?: number
        output?: number
      }
    }
    part?: {
      id?: string
      messageID?: string
      sessionID?: string
      type?: string
      text?: string
      time?: {
        start?: number
        end?: number
      }
      tokens?: {
        total?: number
        input?: number
        output?: number
      }
    }
  }
}

/**
 * MiMo Server 会对删除等操作强制发出权限事件。微信端运行于完全免授权模式，
 * 因此客户端收到事件后直接批准，不再建立用户授权队列。
 */
async function approvePermission(requestId: string, cwd: string): Promise<void> {
  const response = await fetch(
    serverUrl(`/permission/${encodeURIComponent(requestId)}/reply`, cwd),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: "once" }),
    },
  )
  if (!response.ok) {
    throw new Error(`自动批准 MiMo 权限失败：HTTP ${response.status}`)
  }
}

function serverUrl(path: string, cwd: string): URL {
  const url = new URL(path, `${MIMO_SERVER_URL.replace(/\/+$/, "")}/`)
  url.searchParams.set("directory", cwd)
  return url
}

async function createSession(
  cwd: string,
  permission?: MimoPermissionRule[],
  contextFrom?: string,
): Promise<string> {
  const response = await fetch(serverUrl("/session", cwd), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(permission ? { permission } : {}),
      ...(contextFrom ? { contextFrom } : {}),
    }),
  })
  if (!response.ok) {
    throw new Error(`MiMo Server 创建会话失败：HTTP ${response.status}`)
  }
  const data = await response.json() as { id?: string }
  if (!data.id) throw new Error("MiMo Server 创建会话失败：缺少 session ID")
  return data.id
}

function samePermissions(
  current: MimoPermissionRule[] | undefined,
  expected: MimoPermissionRule[],
): boolean {
  return JSON.stringify(current ?? []) === JSON.stringify(expected)
}

async function ensureSessionPermissions(
  sessionId: string,
  cwd: string,
  permission: MimoPermissionRule[],
): Promise<string> {
  const response = await fetch(
    serverUrl(`/session/${encodeURIComponent(sessionId)}`, cwd),
  )
  if (!response.ok) {
    if (response.status === 404) return createSession(cwd, permission)
    throw new Error(`MiMo Server 读取会话权限失败：HTTP ${response.status}`)
  }
  const session = await response.json() as { permission?: MimoPermissionRule[] }
  if (samePermissions(session.permission, permission)) return sessionId
  return createSession(cwd, permission, sessionId)
}

async function isSessionBusy(sessionId: string, cwd: string): Promise<boolean> {
  try {
    const response = await fetch(serverUrl("/session/status", cwd))
    if (!response.ok) return false
    const statuses = await response.json() as Record<string, { type?: string }>
    return statuses[sessionId]?.type === "busy"
  } catch {
    return false
  }
}

async function waitForSessionIdle(sessionId: string, cwd: string): Promise<boolean> {
  const deadline = Date.now() + ABORT_WAIT_MS
  while (Date.now() < deadline) {
    if (!await isSessionBusy(sessionId, cwd)) return true
    await Bun.sleep(STATUS_POLL_MS)
  }
  return !await isSessionBusy(sessionId, cwd)
}

async function abortSession(sessionId: string, cwd: string): Promise<boolean> {
  try {
    await fetch(serverUrl(`/session/${encodeURIComponent(sessionId)}/abort`, cwd), {
      method: "POST",
      signal: AbortSignal.timeout(3_000),
    })
  } catch {
    // 即使中止请求的连接断开，也继续通过状态接口确认会话已空闲。
  }
  return waitForSessionIdle(sessionId, cwd)
}

async function compactSession(
  sessionId: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<MimoResult> {
  try {
    const response = await fetch(
      serverUrl(`/session/${encodeURIComponent(sessionId)}/summarize`, cwd),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerID: DEFAULT_PROVIDER_ID,
          modelID: DEFAULT_MODEL_ID,
        }),
        signal,
      },
    )
    if (!response.ok) {
      return {
        success: false,
        text: "",
        error: response.status === 404
          ? "no text response"
          : `MiMo Server 压缩失败：HTTP ${response.status}`,
        sessionId,
      }
    }
    return {
      success: true,
      text: "上下文压缩完成。",
      sessionId,
      model: {
        providerID: DEFAULT_PROVIDER_ID,
        modelID: DEFAULT_MODEL_ID,
      },
    }
  } catch (error) {
    if (signal?.aborted) {
      return { success: false, text: "", error: "aborted", sessionId }
    }
    return {
      success: false,
      text: "",
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    }
  }
}

function tokenUsage(value?: {
  total?: number
  input?: number
  output?: number
}): MimoResult["tokens"] | undefined {
  if (!value) return undefined
  return {
    total: value.total ?? 0,
    input: value.input ?? 0,
    output: value.output ?? 0,
  }
}

export async function askMimo(
  sessionId: string | undefined,
  message: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress?: (progress: MimoProgress) => void,
  permission?: MimoPermissionRule[],
): Promise<MimoResult> {
  mkdirSync(cwd, { recursive: true })
  if (signal?.aborted) return { success: false, text: "", error: "aborted" }

  let resolvedSessionId = sessionId
  try {
    if (!resolvedSessionId) {
      resolvedSessionId = await createSession(cwd, permission)
    } else if (permission) {
      resolvedSessionId = await ensureSessionPermissions(
        resolvedSessionId,
        cwd,
        permission,
      )
    }
  } catch (error) {
    return {
      success: false,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const activeSessionId = resolvedSessionId
  if (await isSessionBusy(activeSessionId, cwd)) {
    const idle = await abortSession(activeSessionId, cwd)
    if (!idle) {
      return {
        success: false,
        text: "",
        error: "MiMo Server 会话仍在处理中，请稍后重试",
        sessionId: activeSessionId,
      }
    }
  }
  if (message.trim() === "/compact") {
    return compactSession(activeSessionId, cwd, signal)
  }

  const eventController = new AbortController()
  const assistantMessageIds = new Set<string>()
  const textParts = new Map<string, string>()
  const pendingTextPartIds = new Set<string>()
  const reportedTextPartIds = new Set<string>()
  let model: MimoResult["model"]
  let tokens: MimoResult["tokens"]
  let eventError: string | undefined
  let timedOut = false
  let aborted = false
  let abortPromise: Promise<void> | undefined
  let settled = false
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = () => {
      if (settled) return
      settled = true
      eventController.abort()
      resolve()
    }
  })

  const currentText = () => [...textParts.values()]
    .map((text) => normalizeTrailingColon(text.trim()))
    .filter(Boolean)
    .join("\n")
    .trim()
  const reportProgress = (delta?: string) => {
    onProgress?.({
      text: currentText(),
      delta,
      sessionId: activeSessionId,
      model,
      tokens,
    })
  }

  const flushIntermediateText = () => {
    const deltas: string[] = []
    for (const partId of pendingTextPartIds) {
      if (reportedTextPartIds.has(partId)) continue
      const rawText = textParts.get(partId)?.trim()
      const text = rawText ? normalizeTrailingColon(rawText) : ""
      if (text) deltas.push(text)
      reportedTextPartIds.add(partId)
    }
    pendingTextPartIds.clear()
    const delta = deltas.join("\n").trim()
    if (delta) reportProgress(delta)
  }

  const abortAndFinish = (reason: "aborted" | "timeout") => {
    if (settled || abortPromise) return
    if (reason === "timeout") timedOut = true
    else aborted = true
    abortPromise = (async () => {
      await abortSession(activeSessionId, cwd)
      finish()
    })()
  }
  const abortListener = () => abortAndFinish("aborted")
  signal?.addEventListener("abort", abortListener, { once: true })

  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        abortAndFinish("timeout")
      }, timeoutMs)
    : undefined

  function handleEvent(event: ServerEvent): void {
    const properties = event.properties
    if (!properties || properties.sessionID !== activeSessionId) return

    if (event.type === "permission.asked") {
      const requestId = properties.id ?? properties.requestID
      if (!requestId) return
      void approvePermission(requestId, cwd).catch((error) => {
        console.log(`[mimo] permission auto-approval failed: ${error}`)
      })
      return
    }

    if (event.type === "message.updated" && properties.info) {
      const info = properties.info
      if (info.role === "assistant" && info.id) assistantMessageIds.add(info.id)
      if (info.providerID || info.modelID) {
        model = { providerID: info.providerID, modelID: info.modelID }
      }
      const updatedTokens = tokenUsage(info.tokens)
      if (updatedTokens) tokens = updatedTokens
      return
    }

    if (event.type === "message.part.updated" && properties.part) {
      const part = properties.part
      if (!part.messageID || !assistantMessageIds.has(part.messageID)) return
      if (part.type === "text" && part.id) {
        textParts.set(part.id, part.text ?? "")
        if (part.time?.end !== undefined) pendingTextPartIds.add(part.id)
        return
      }
      if (part.type === "step-finish") {
        // step-finish 前的文本就是最终回复，由 Bot 统一发送，避免重复。
        pendingTextPartIds.clear()
        const updatedTokens = tokenUsage(part.tokens)
        if (updatedTokens) tokens = updatedTokens
        return
      }
      // 文本后又出现推理、工具或新步骤，说明它是阶段性输出，立即推送。
      flushIntermediateText()
      return
    }

    if (event.type === "session.error") {
      eventError = typeof properties.error === "string"
        ? properties.error
        : properties.error?.message ?? "MiMo Server 会话错误"
      finish()
      return
    }

    if (event.type === "session.idle") {
      pendingTextPartIds.clear()
      finish()
    }
  }

  try {
    const eventResponse = await fetch(serverUrl("/event", cwd), {
      headers: { accept: "text/event-stream" },
      signal: eventController.signal,
    })
    if (!eventResponse.ok || !eventResponse.body) {
      eventError = `MiMo Server 事件流失败：HTTP ${eventResponse.status}`
      finish()
    } else {
      const reader = eventResponse.body.getReader()
      const decoder = new TextDecoder()
      void (async () => {
        try {
          let buffered = ""
          while (!settled) {
            const { value, done } = await reader.read()
            if (done) {
              if (!settled) {
                eventError = "MiMo Server 事件流已断开"
                finish()
              }
              break
            }
            buffered += decoder.decode(value, { stream: true })
            const lines = buffered.split(/\r?\n/)
            buffered = lines.pop() ?? ""
            for (const line of lines) {
              if (!line.startsWith("data:")) continue
              try {
                handleEvent(JSON.parse(line.slice(5).trim()) as ServerEvent)
              } catch {
                // 忽略心跳和非 JSON SSE 数据。
              }
            }
          }
        } catch (error) {
          if (!settled && !eventController.signal.aborted) {
            eventError = error instanceof Error ? error.message : String(error)
            finish()
          }
        }
      })()
    }

    if (!settled) {
      const response = await fetch(
        serverUrl(`/session/${encodeURIComponent(activeSessionId)}/prompt_async`, cwd),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: {
              providerID: DEFAULT_PROVIDER_ID,
              modelID: DEFAULT_MODEL_ID,
            },
            parts: [{ type: "text", text: message }],
          }),
        },
      )
      if (!response.ok) {
        eventError = response.status === 404
          ? "no text response"
          : `MiMo Server 请求失败：HTTP ${response.status}`
        finish()
      }
    }

    await finished
  } catch (error) {
    eventError = error instanceof Error ? error.message : String(error)
    finish()
  } finally {
    if (timeout) clearTimeout(timeout)
    signal?.removeEventListener("abort", abortListener)
    if (abortPromise) await abortPromise
    eventController.abort()
  }

  if (aborted || signal?.aborted) {
    return { success: false, text: "", error: "aborted", sessionId: activeSessionId, model, tokens }
  }
  if (timedOut) {
    return { success: false, text: "", error: "timeout", sessionId: activeSessionId, model, tokens }
  }

  const text = currentText()
  if (text) {
    return { success: true, text, sessionId: activeSessionId, model, tokens }
  }
  return {
    success: false,
    text: "",
    error: eventError ?? "no text response",
    sessionId: activeSessionId,
    model,
    tokens,
  }
}
