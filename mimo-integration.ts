import { mkdirSync } from "fs"

const DEFAULT_TIMEOUT_MS = 300_000

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
  sessionId?: string
  model?: MimoResult["model"]
  tokens?: MimoResult["tokens"]
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
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

  const args = ["mimo", "run", "--format", "json"]
  if (sessionId) args.push("--session", sessionId)
  args.push(message)

  const seconds = Math.ceil(timeoutMs / 1000)
  const command = `exec timeout ${seconds} ${args.map(shellQuote).join(" ")}`
  const env = { ...process.env }

  // MiMoCode 必须直连；历史配置中的 127.0.0.1:7890 已失效。
  for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
    delete env[key]
  }

  const proc = Bun.spawn(["script", "-q", "-e", "-c", command, "/dev/null"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const abort = () => proc.kill()
  signal?.addEventListener("abort", abort, { once: true })

  let resolvedSessionId = sessionId
  let model: MimoResult["model"]
  let tokens: MimoResult["tokens"]
  const textParts: string[] = []
  const errors: string[] = []

  function parseLine(line: string): void {
    const value = line.trim()
    if (!value.startsWith("{")) return

    try {
      const event = JSON.parse(value) as {
        type?: string
        sessionID?: string
        providerID?: string
        modelID?: string
        info?: {
          providerID?: string
          modelID?: string
          model?: {
            providerID?: string
            modelID?: string
          }
        }
        error?: { message?: string } | string
        part?: {
          type?: string
          text?: string
          tokens?: {
            total?: number
            input?: number
            output?: number
          }
        }
      }

      if (event.sessionID) resolvedSessionId = event.sessionID
      const providerID = event.providerID ?? event.info?.providerID ?? event.info?.model?.providerID
      const modelID = event.modelID ?? event.info?.modelID ?? event.info?.model?.modelID
      if (providerID || modelID) model = { providerID, modelID }
      if (event.type === "text" && event.part?.text) {
        textParts.push(event.part.text)
        onProgress?.({ text: textParts.join("\n").trim(), sessionId: resolvedSessionId, model, tokens })
      }
      if (event.type === "error") {
        errors.push(typeof event.error === "string" ? event.error : event.error?.message ?? "MiMoCode error")
      }
      if (event.type === "step_finish" && event.part?.tokens) {
        tokens = {
          total: event.part.tokens.total ?? 0,
          input: event.part.tokens.input ?? 0,
          output: event.part.tokens.output ?? 0,
        }
        onProgress?.({ text: textParts.join("\n").trim(), sessionId: resolvedSessionId, model, tokens })
      }
    } catch {
      // script 会混入终端控制行，仅解析合法 JSON 事件。
    }
  }

  async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split(/\r?\n/)
        buffered = lines.pop() ?? ""
        for (const line of lines) parseLine(line)
      }
      buffered += decoder.decode()
      if (buffered) parseLine(buffered)
    } finally {
      reader.releaseLock()
    }
  }

  const [exitCode] = await Promise.all([
    proc.exited,
    readStream(proc.stdout),
    readStream(proc.stderr),
  ])
  signal?.removeEventListener("abort", abort)

  if (signal?.aborted) return { success: false, text: "", error: "aborted" }
  if (exitCode === 124) return { success: false, text: "", error: "timeout", sessionId: resolvedSessionId, model, tokens }

  const text = textParts.join("\n").trim()
  if (text) return { success: true, text, sessionId: resolvedSessionId, model, tokens }

  return {
    success: false,
    text: "",
    sessionId: resolvedSessionId,
    model,
    error: errors.at(-1) ?? `no text response (exit ${exitCode})`,
  }
}
