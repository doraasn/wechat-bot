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
import {
  archiveIncomingMedia,
  createOutgoingMediaItem,
  DEFAULT_CDN_BASE_URL,
  DEFAULT_MEDIA_MAX_BYTES,
  type IncomingAttachment,
  type MediaMessageItem,
} from "./ilink-media"
import { transcribeVoice } from "./voice-transcribe"

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
const DEFAULT_STATE_DIR = "/data/projects/wechat-bot/data/ilink"
const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const RETRY_DELAY_MS = 2_000
const BACKOFF_DELAY_MS = 30_000
const SEND_RETRY_ATTEMPTS = 3
// 会话过期错误码：token 失效后微信对所有请求都回 -14，重试没有意义。
const SESSION_EXPIRED_ERRCODE = -14
const SESSION_PAUSE_MS = 60 * 60 * 1_000
// 等待一律分段睡眠，保证停止服务时不会被长退避卡住（实测 30s 退避会拖住 shutdown）。
const SLEEP_SLICE_MS = 5_000

const MessageType = { USER: 1, BOT: 2 } as const
const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const
const MessageState = { FINISH: 2 } as const
const TypingStatus = { TYPING: 1, CANCEL: 2 } as const

type MessageItem = MediaMessageItem & {
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
  cdnBaseUrl?: string
  userId?: string
}

type SendContext = {
  accountId?: string
  contextToken: string
  typingTicket: string
  updatedAt: string
}

type PersistedContexts = Record<string, SendContext>

type SendMessageResponse = {
  ret?: number
  errcode?: number
  errmsg?: string
}

export function assertSendMessageResponse(response: SendMessageResponse): void {
  const ret = response.ret ?? 0
  const errcode = response.errcode ?? 0
  if (errcode === SESSION_EXPIRED_ERRCODE) {
    throw new Error(`微信会话已过期（errcode=-14），需要重新扫码登录：${response.errmsg ?? ""}`.trim())
  }
  if (ret !== 0 || errcode !== 0) {
    throw new Error(`微信发送失败：ret=${ret} errcode=${errcode} ${response.errmsg ?? ""}`.trim())
  }
}

export type ILinkInboundMessage = {
  id: string
  from: string
  text: string
  attachments: IncomingAttachment[]
  timestamp: number
}

export type ILinkStatus = {
  ready: boolean
  accountId?: string
  accountIds: string[]
  accounts: number
  users: number
  running: boolean
}

/** 可被 abort 打断的睡眠：长退避或会话暂停不应阻塞服务停止。 */
async function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  const wakeAt = Date.now() + ms
  while (!signal.aborted && Date.now() < wakeAt) {
    await Bun.sleep(Math.min(SLEEP_SLICE_MS, wakeAt - Date.now()))
  }
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
  const parts: string[] = []
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const text = item.text_item.text
      parts.push(item.ref_msg?.title ? `[引用: ${item.ref_msg.title}]\n${text}` : text)
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      parts.push(`[语音] ${item.voice_item.text}`)
    }
  }
  return parts.join("\n")
}

function attachmentPrompt(attachments: IncomingAttachment[]): string {
  if (!attachments.length) return ""
  return [
    "【收到微信附件】",
    ...attachments.map((attachment) =>
      `- ${attachment.type}：${attachment.name}\n  本地路径：${attachment.path}\n  类型：${attachment.mime}，大小：${attachment.size} 字节`
    ),
    "请直接读取上述本地文件，并结合用户要求处理。",
  ].join("\n")
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
  private readonly accounts = new Map<string, AccountData>()
  private abortController?: AbortController
  private readonly monitors = new Map<string, Promise<void>>()

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
    const accountIds = [...this.accounts.keys()]
    return {
      ready: accountIds.length > 0,
      accountId: accountIds[0],
      accountIds,
      accounts: accountIds.length,
      users: this.contexts.size,
      running: this.monitors.size > 0,
    }
  }

  private loadAccounts(): void {
    const ids = [...new Set(
      readJson<string[]>(path.join(this.stateDir, "accounts.json"), [])
        .map((id) => id.trim())
        .filter(Boolean),
    )]
    this.accounts.clear()
    for (const accountId of ids) {
      const file = path.join(this.stateDir, "accounts", `${accountId}.json`)
      const account = readJson<AccountData>(file, {})
      if (!account.token) {
        console.log(`[ilink] skipped account without token: ${accountId}`)
        continue
      }
      this.accounts.set(accountId, account)
    }
    if (!this.accounts.size) {
      throw new Error(`未找到可用微信账号：${this.stateDir}/accounts.json`)
    }
  }

  private contextAccountId(userId: string, context: SendContext): string {
    if (context.accountId && this.accounts.has(context.accountId)) {
      return context.accountId
    }
    const matched = [...this.accounts.entries()]
      .find(([, account]) => account.userId === userId)?.[0]
    const accountId = matched ?? this.accounts.keys().next().value
    if (!accountId) throw new Error("微信 iLink 账号尚未就绪")
    context.accountId = accountId
    this.persistContexts()
    return accountId
  }

  private persistContexts(): void {
    atomicWriteJson(
      path.join(this.stateDir, "contexts.json"),
      Object.fromEntries(this.contexts),
    )
  }

  private async request<T>(
    accountId: string,
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs = API_TIMEOUT_MS,
  ): Promise<T> {
    const account = this.accounts.get(accountId)
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

  private async refreshTypingTicket(
    accountId: string,
    userId: string,
    contextToken: string,
  ): Promise<string> {
    const current = this.contexts.get(userId)
    if (
      current?.accountId === accountId &&
      current?.typingTicket &&
      Date.now() - Date.parse(current.updatedAt) < 24 * 60 * 60 * 1_000
    ) {
      return current.typingTicket
    }
    try {
      const response = await this.request<{
        ret?: number
        typing_ticket?: string
      }>(accountId, "ilink/bot/getconfig", {
        ilink_user_id: userId,
        context_token: contextToken,
      }, 10_000)
      return response.ret === 0 ? response.typing_ticket ?? "" : ""
    } catch (error) {
      console.log(`[ilink] getconfig failed user=${userId}: ${error}`)
      return current?.accountId === accountId ? current.typingTicket : ""
    }
  }

  /** 使用同一个 client_id 重试，依靠微信侧幂等避免产生重复消息。 */
  private async sendMessageWithRetry(
    accountId: string,
    payload: Record<string, unknown>,
    clientId: string,
  ): Promise<void> {
    let lastError: unknown
    for (let attempt = 1; attempt <= SEND_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await this.request<SendMessageResponse>(
          accountId,
          "ilink/bot/sendmessage",
          payload,
        )
        assertSendMessageResponse(response)
        return
      } catch (error) {
        lastError = error
        console.log(`[send] attempt=${attempt}/${SEND_RETRY_ATTEMPTS} client=${clientId} failed: ${error}`)
        if (attempt < SEND_RETRY_ATTEMPTS) await Bun.sleep(attempt * RETRY_DELAY_MS)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async rememberContext(
    accountId: string,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    const typingTicket = await this.refreshTypingTicket(
      accountId,
      userId,
      contextToken,
    )
    this.contexts.set(userId, {
      accountId,
      contextToken,
      typingTicket,
      updatedAt: new Date().toISOString(),
    })
    this.persistContexts()
  }

  async start(
    handler: (message: ILinkInboundMessage) => Promise<void>,
    userDirectory: (userId: string) => string,
  ): Promise<void> {
    if (this.monitors.size) return
    this.loadAccounts()
    this.abortController = new AbortController()
    for (const accountId of this.accounts.keys()) {
      this.monitors.set(
        accountId,
        this.monitorLoop(
          accountId,
          handler,
          userDirectory,
          this.abortController.signal,
        ),
      )
    }
    console.log(`[ilink] started accounts=${[...this.accounts.keys()].join(",")}`)
  }

  async stop(): Promise<void> {
    this.abortController?.abort()
    await Promise.allSettled(this.monitors.values())
    this.monitors.clear()
    this.abortController = undefined
  }

  private async monitorLoop(
    accountId: string,
    handler: (message: ILinkInboundMessage) => Promise<void>,
    userDirectory: (userId: string) => string,
    signal: AbortSignal,
  ): Promise<void> {
    const syncFile = path.join(
      this.stateDir,
      "accounts",
      `${accountId}.sync.json`,
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
        }>(accountId, "ilink/bot/getupdates", {
          get_updates_buf: buffer,
        }, LONG_POLL_TIMEOUT_MS)

        const errcode = response.errcode ?? 0
        if ((response.ret ?? 0) !== 0 || errcode !== 0) {
          const detail = `ret=${response.ret} errcode=${errcode} ${response.errmsg ?? ""}`.trim()
          if (errcode === SESSION_EXPIRED_ERRCODE) {
            // 会话过期后所有请求都会被拒，继续每 30 秒重试只会空转刷日志，
            // 因此暂停该账号一小时，等人工重新扫码登录。
            console.log(
              `[ilink] session expired account=${accountId}（${detail}），暂停 ${SESSION_PAUSE_MS / 60_000} 分钟，需重新扫码登录`,
            )
            failures = 0
            await interruptibleSleep(SESSION_PAUSE_MS, signal)
            continue
          }
          throw new Error(detail)
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
            await this.rememberContext(accountId, from, message.context_token)
          }
          const messageId = String(message.message_id ?? crypto.randomUUID())
          const timestamp = message.create_time_ms ?? Date.now()
          const attachments: IncomingAttachment[] = []
          const mediaErrors: string[] = []
          for (const [itemIndex, item] of (message.item_list ?? []).entries()) {
            try {
              const attachment = await archiveIncomingMedia({
                item,
                userDirectory: userDirectory(from),
                messageId,
                itemIndex,
                timestamp,
                cdnBaseUrl: this.accounts.get(accountId)?.cdnBaseUrl
                  ?? DEFAULT_CDN_BASE_URL,
                maxBytes: parseInt(
                  process.env.WECHAT_MEDIA_MAX_BYTES
                    ?? String(DEFAULT_MEDIA_MAX_BYTES),
                  10,
                ),
              })
              if (attachment) attachments.push(attachment)
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              console.log(`[ilink] media receive failed user=${from}: ${detail}`)
              mediaErrors.push(detail)
            }
          }
          // 语音附件本地转写：微信未下发语音文字时，用本地 whisper 兜底识别
          const voiceTranscripts: string[] = []
          for (const attachment of attachments) {
            if (attachment.type !== "voice") continue
            const transcript = await transcribeVoice(attachment.path)
            if (transcript) voiceTranscripts.push(transcript)
          }
          const text = [
            messageText(message.item_list),
            voiceTranscripts.length
              ? `【语音转写】\n${voiceTranscripts.map((item) => `- ${item}`).join("\n")}`
              : "",
            attachmentPrompt(attachments),
            mediaErrors.length
              ? `【附件接收失败】\n${mediaErrors.map((error) => `- ${error}`).join("\n")}`
              : "",
          ].filter(Boolean).join("\n\n")
          await handler({
            id: messageId,
            from,
            text: text || "[未知消息]",
            attachments,
            timestamp,
          })
        }
      } catch (error) {
        if (signal.aborted) break
        if (error instanceof Error && error.name === "AbortError") {
          continue
        }
        failures += 1
        console.log(`[ilink] monitor error account=${accountId} (${failures}): ${error}`)
        await interruptibleSleep(failures >= 3 ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
        if (failures >= 3) failures = 0
      }
    }
    console.log(`[ilink] stopped account=${accountId}`)
  }

  async sendText(to: string, markdown: string, deliveryId: string = crypto.randomUUID()): Promise<void> {
    const context = this.contexts.get(to)
    if (!context?.contextToken) throw new Error(`用户 ${to} 缺少 context_token`)
    const accountId = this.contextAccountId(to, context)
    const chunks = splitMarkdown(markdown)
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index] ?? ""
      const clientId = `wechat-mimo-${deliveryId}-${index}`
      await this.sendMessageWithRetry(accountId, {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{
            type: MessageItemType.TEXT,
            text_item: { text: chunk },
          }],
          context_token: context.contextToken,
        },
      }, clientId)
    }
  }

  /** 上传并发送图片、视频或普通文件。 */
  async sendMedia(to: string, filePath: string, deliveryId: string = crypto.randomUUID()): Promise<void> {
    // 允许诊断脚本只初始化发送端，不启动 getupdates 长轮询。
    if (!this.accounts.size) this.loadAccounts()
    const context = this.contexts.get(to)
    if (!context?.contextToken) throw new Error(`用户 ${to} 缺少 context_token`)
    const accountId = this.contextAccountId(to, context)
    const account = this.accounts.get(accountId)
    const item = await createOutgoingMediaItem({
      filePath,
      toUserId: to,
      cdnBaseUrl: account?.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
      maxBytes: parseInt(
        process.env.WECHAT_MEDIA_MAX_BYTES ?? String(DEFAULT_MEDIA_MAX_BYTES),
        10,
      ),
      getUploadUrl: (payload) =>
        this.request(accountId, "ilink/bot/getuploadurl", payload),
    })
    const clientId = `wechat-mimo-${deliveryId}`
    await this.sendMessageWithRetry(accountId, {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: context.contextToken,
      },
    }, clientId)
  }

  async sendTyping(to: string, typing: boolean): Promise<void> {
    const context = this.contexts.get(to)
    if (!context?.typingTicket) return
    const accountId = this.contextAccountId(to, context)
    await this.request(accountId, "ilink/bot/sendtyping", {
      ilink_user_id: to,
      typing_ticket: context.typingTicket,
      status: typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
    }, 10_000)
  }
}
