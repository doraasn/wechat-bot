import { mkdirSync } from "fs"

const DEFAULT_TIMEOUT_MS = 300_000
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

type ServerEvent = {
  type?: string
  properties?: {
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

function serverUrl(path: string, cwd: string): URL {
  const url = new URL(path, `${MIMO_SERVER_URL.replace(/\/+$/, "")}/`)
  url.searchParams.set("directory", cwd)
  return url
}

async function createSession(cwd: string): Promise<string> {
  const response = await fetch(serverUrl("/session", cwd), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
  if (!response.ok) {
    throw new Error(`MiMo Server 创建会话失败：HTTP ${response.status}`)
  }
  const data = await response.json() as { id?: string }
  if (!data.id) throw new Error("MiMo Server 创建会话失败：缺少 session ID")
  return data.id
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
): Promise<MimoResult> {
  mkdirSync(cwd, { recursive: true })
  if (signal?.aborted) return { success: false, text: "", error: "aborted" }

  let resolvedSessionId = sessionId
  try {
    if (!resolvedSessionId) resolvedSessionId = await createSession(cwd)
  } catch (error) {
    return {
      success: false,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const activeSessionId = resolvedSessionId
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

  const currentText = () => [...textParts.values()].join("\n").trim()
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
      const text = textParts.get(partId)?.trim()
      if (text) deltas.push(text)
      reportedTextPartIds.add(partId)
    }
    pendingTextPartIds.clear()
    const delta = deltas.join("\n").trim()
    if (delta) reportProgress(delta)
  }

  const abortServerSession = async () => {
    try {
      await fetch(serverUrl(`/session/${encodeURIComponent(activeSessionId)}/abort`, cwd), {
        method: "POST",
      })
    } catch {
      // 服务端连接中断时，本地 SSE 仍会被关闭。
    }
  }

  const abortListener = () => {
    aborted = true
    void abortServerSession()
    finish()
  }
  signal?.addEventListener("abort", abortListener, { once: true })

  const timeout = setTimeout(() => {
    timedOut = true
    void abortServerSession()
    finish()
  }, timeoutMs)

  function handleEvent(event: ServerEvent): void {
    const properties = event.properties
    if (!properties || properties.sessionID !== activeSessionId) return

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
          body: JSON.stringify({ parts: [{ type: "text", text: message }] }),
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
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abortListener)
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
