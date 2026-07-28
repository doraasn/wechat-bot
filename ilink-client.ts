/**
 * 微信 iLink/ClawBot 协议客户端。
 *
 * 协议实现参考 weixin-clawbot-bridge（MIT License，Copyright (c) 2026
 * cooooooooooode），仅保留本项目需要的账号恢复、消息轮询、文本发送和输入状态。
 */
import crypto from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
const DEFAULT_STATE_DIR = "/data/projects/wechat-bot/data/ilink"
const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000

const MessageType = { USER: 1, BOT: 2 } as const
const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const
const MessageState = { FINISH: 2 } as const
const TypingStatus = { TYPING: 1, CANCEL: 2 } as const

type MessageItem = {
  type?: number
  text_item?: { text?: string }
  voice_item?: { text?: string }
  ref_msg?: { title?: string }
}

type ILinkMessage = {
  message_id?: number
  from_user_id?: string
  message_type?: number
  create_time_ms?: number
  context_token?: string
  item_list?: MessageItem[]
}

type AccountData = {
  token?: string
  baseUrl?: string
  userId?: string
}

type SendContext = {
  contextToken: string
  typingTicket: string
  updatedAt: string
}

type PersistedContexts = Record<string, SendContext>

export type ILinkInboundMessage = {
  id: string
  from: string
  text: string
  timestamp: number
}

export type ILinkStatus = {
  ready: boolean
  accountId?: string
  users: number
  running: boolean
}

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 })
  renameSync(temp, file)
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T
  } catch {
    return fallback
  }
}

function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), "utf-8").toString("base64")
}

function messageText(items?: MessageItem[]): string {
  if (!items?.length) return ""
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const text = item.text_item.text
      return item.ref_msg?.title ? `[引用: ${item.ref_msg.title}]\n${text}` : text
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return `[语音] ${item.voice_item.text}`
    }
  }
  const item = items[0]
  if (item?.type === MessageItemType.IMAGE) return "[图片消息]"
  if (item?.type === MessageItemType.FILE) return "[文件消息]"
  if (item?.type === MessageItemType.VIDEO) return "[视频消息]"
  if (item?.type === MessageItemType.VOICE) return "[语音消息]"
  return "[未知消息]"
}

/** 尽量按换行边界拆分，避免在 Markdown 表格行中间截断。 */
function splitMarkdown(text: string, limit = 4_000): string[] {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf("\n", limit)
    if (end < Math.floor(limit * 0.6)) end = limit
    chunks.push(remaining.slice(0, end))
    remaining = remaining.slice(end).replace(/^\n/, "")
  }
  if (remaining || chunks.length === 0) chunks.push(remaining)
  return chunks
}

export class ILinkClient {
  private readonly stateDir =
    process.env.WECHAT_ILINK_STATE_DIR ?? DEFAULT_STATE_DIR
  private readonly contexts = new Map<string, SendContext>()
  private abortController?: AbortController
  private monitor?: Promise<void>
  private accountId?: string
  private account?: AccountData

  constructor() {
    const saved = readJson<PersistedContexts>(
      path.join(this.stateDir, "contexts.json"),
      {},
    )
    for (const [userId, context] of Object.entries(saved)) {
      if (context.contextToken) this.contexts.set(userId, context)
    }
  }

  status(): ILinkStatus {
    return {
      ready: Boolean(this.account?.token),
      accountId: this.accountId,
      users: this.contexts.size,
      running: Boolean(this.monitor),
    }
  }

  private loadAccount(): void {
    const ids = readJson<string[]>(path.join(this.stateDir, "accounts.json"), [])
    const accountId = ids.find(Boolean)
    if (!accountId) throw new Error(`未找到微信账号：${this.stateDir}/accounts.json`)
    const file = path.join(this.stateDir, "accounts", `${accountId}.json`)
    const account = readJson<AccountData>(file, {})
    if (!account.token) throw new Error(`微信账号缺少 token：${file}`)
    this.accountId = accountId
    this.account = account
  }

  private persistContexts(): void {
    atomicWriteJson(
      path.join(this.stateDir, "contexts.json"),
      Object.fromEntries(this.contexts),
    )
  }

  private async request<T>(
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs = API_TIMEOUT_MS,
  ): Promise<T> {
    const account = this.account
    if (!account?.token) throw new Error("微信 iLink 账号尚未就绪")
    const body = JSON.stringify({
      ...payload,
      base_info: { channel_version: "wechat-mimocode-bot/1" },
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const baseUrl = (account.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")
      const response = await fetch(`${baseUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${account.token}`,
          "X-WECHAT-UIN": randomWechatUin(),
        },
        body,
        signal: controller.signal,
      })
      const raw = await response.text()
      if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}: ${raw}`)
      return (raw ? JSON.parse(raw) : {}) as T
    } finally {
      clearTimeout(timer)
    }
  }

  private async refreshTypingTicket(userId: string, contextToken: string): Promise<string> {
    const current = this.contexts.get(userId)
    if (
      current?.typingTicket &&
      Date.now() - Date.parse(current.updatedAt) < 24 * 60 * 60 * 1_000
    ) {
      return current.typingTicket
    }
    try {
      const response = await this.request<{
        ret?: number
        typing_ticket?: string
      }>("ilink/bot/getconfig", {
        ilink_user_id: userId,
        context_token: contextToken,
      }, 10_000)
      return response.ret === 0 ? response.typing_ticket ?? "" : ""
    } catch (error) {
      console.log(`[ilink] getconfig failed user=${userId}: ${error}`)
      return current?.typingTicket ?? ""
    }
  }

  private async rememberContext(userId: string, contextToken: string): Promise<void> {
    const typingTicket = await this.refreshTypingTicket(userId, contextToken)
    this.contexts.set(userId, {
      contextToken,
      typingTicket,
      updatedAt: new Date().toISOString(),
    })
    this.persistContexts()
  }

  async start(handler: (message: ILinkInboundMessage) => Promise<void>): Promise<void> {
    if (this.monitor) return
    this.loadAccount()
    this.abortController = new AbortController()
    this.monitor = this.monitorLoop(handler, this.abortController.signal)
    console.log(`[ilink] started account=${this.accountId}`)
  }

  async stop(): Promise<void> {
    this.abortController?.abort()
    await this.monitor?.catch(() => {})
    this.monitor = undefined
    this.abortController = undefined
  }

  private async monitorLoop(
    handler: (message: ILinkInboundMessage) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const syncFile = path.join(
      this.stateDir,
      "accounts",
      `${this.accountId}.sync.json`,
    )
    let buffer = readJson<{ get_updates_buf?: string }>(syncFile, {}).get_updates_buf ?? ""
    let failures = 0

    while (!signal.aborted) {
      try {
        const response = await this.request<{
          ret?: number
          errcode?: number
          errmsg?: string
          msgs?: ILinkMessage[]
          get_updates_buf?: string
          longpolling_timeout_ms?: number
        }>("ilink/bot/getupdates", {
          get_updates_buf: buffer,
        }, LONG_POLL_TIMEOUT_MS)

        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          throw new Error(
            `ret=${response.ret} errcode=${response.errcode} ${response.errmsg ?? ""}`,
          )
        }
        failures = 0
        if (response.get_updates_buf) {
          buffer = response.get_updates_buf
          atomicWriteJson(syncFile, { get_updates_buf: buffer })
        }
        for (const message of response.msgs ?? []) {
          if (message.message_type !== undefined && message.message_type !== MessageType.USER) {
            continue
          }
          const from = message.from_user_id
          if (!from) continue
          if (message.context_token) {
            await this.rememberContext(from, message.context_token)
          }
          await handler({
            id: String(message.message_id ?? crypto.randomUUID()),
            from,
            text: messageText(message.item_list),
            timestamp: message.create_time_ms ?? Date.now(),
          })
        }
      } catch (error) {
        if (signal.aborted) break
        if (error instanceof Error && error.name === "AbortError") {
          continue
        }
        failures += 1
        console.log(`[ilink] monitor error (${failures}): ${error}`)
        await Bun.sleep(failures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS)
        if (failures >= 3) failures = 0
      }
    }
    console.log("[ilink] stopped")
  }

  async sendText(to: string, markdown: string): Promise<void> {
    const context = this.contexts.get(to)
    if (!context?.contextToken) throw new Error(`用户 ${to} 缺少 context_token`)
    for (const chunk of splitMarkdown(markdown)) {
      await this.request("ilink/bot/sendmessage", {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: `wechat-mimo-${crypto.randomUUID()}`,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{
            type: MessageItemType.TEXT,
            text_item: { text: chunk },
          }],
          context_token: context.contextToken,
        },
      })
    }
  }

  async sendTyping(to: string, typing: boolean): Promise<void> {
    const context = this.contexts.get(to)
    if (!context?.typingTicket) return
    await this.request("ilink/bot/sendtyping", {
      ilink_user_id: to,
      typing_ticket: context.typingTicket,
      status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
    }, 10_000)
  }
}
