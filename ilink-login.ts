/**
 * 微信 iLink 扫码登录工具。
 *
 * 协议流程参考 weixin-clawbot-bridge（MIT License，Copyright (c) 2026
 * cooooooooooode），登录凭据仅保存到本机 data/ilink。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// 默认连微信生产域名；WECHAT_ILINK_BASE_URL 仅用于本地联调与自动化测试。
const BASE_URL = (
  process.env.WECHAT_ILINK_BASE_URL ?? "https://ilinkai.weixin.qq.com"
).replace(/\/+$/, "")
const STATE_DIR =
  process.env.WECHAT_ILINK_STATE_DIR ??
  "/data/projects/wechat-bot/data/ilink"
// 二维码过期后自动换新码的次数上限，避免无限重试。
const QR_REFRESH_MAX = Number.parseInt(
  process.env.WECHAT_ILINK_QR_REFRESH_MAX ?? "3",
  10,
)
const LOGIN_DEADLINE_MS = 8 * 60_000

type QrResponse = {
  qrcode?: string
  qrcode_img_content?: string
}

type StatusResponse = {
  status?: "wait" | "scaned" | "scaned_but_redirect" | "confirmed" | "expired"
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  /** 微信要求换机房时给出的域名，后续轮询必须改用它。 */
  redirect_host?: string
}

async function fetchJson<T>(url: string, timeoutMs = 35_000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  const raw = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw}`)
  return JSON.parse(raw) as T
}

/** 微信可能返回裸域名（无协议），统一补全并去掉结尾斜杠。 */
function normalizeBaseUrl(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return withScheme.replace(/\/+$/, "")
}

async function fetchQrcode(baseUrl: string): Promise<QrResponse> {
  const qr = await fetchJson<QrResponse>(
    `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`,
    15_000,
  )
  if (!qr.qrcode || !qr.qrcode_img_content) {
    throw new Error("获取二维码失败：响应缺少二维码")
  }
  return qr
}

function printQrcode(qr: QrResponse, label: string): void {
  console.log(label)
  console.log(qr.qrcode_img_content)
}

function saveAccount(status: StatusResponse): string {
  if (!status.ilink_bot_id || !status.bot_token) {
    throw new Error("登录成功响应缺少 ilink_bot_id 或 bot_token")
  }
  const accountId = status.ilink_bot_id.trim().replace(/[@.]/g, "-")
  const accountsDir = path.join(STATE_DIR, "accounts")
  mkdirSync(accountsDir, { recursive: true })
  let accountIds: string[] = []
  try {
    const saved = JSON.parse(
      readFileSync(path.join(STATE_DIR, "accounts.json"), "utf-8"),
    ) as unknown
    if (Array.isArray(saved)) {
      accountIds = saved.filter((value): value is string => typeof value === "string")
    }
  } catch {
    // 首次登录时账号列表尚不存在。
  }
  writeFileSync(
    path.join(STATE_DIR, "accounts.json"),
    JSON.stringify([...new Set([...accountIds.filter(Boolean), accountId])], null, 2),
    { encoding: "utf-8", mode: 0o600 },
  )
  writeFileSync(
    path.join(accountsDir, `${accountId}.json`),
    JSON.stringify({
      token: status.bot_token,
      savedAt: new Date().toISOString(),
      baseUrl: status.baseurl || BASE_URL,
      userId: status.ilink_user_id,
    }, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  )
  return accountId
}

async function main(): Promise<void> {
  let baseUrl = BASE_URL
  let qr = await fetchQrcode(baseUrl)
  printQrcode(qr, "请使用微信扫描以下二维码并在手机端确认：")
  console.log("等待确认，最长 8 分钟……")

  const deadline = Date.now() + LOGIN_DEADLINE_MS
  let scanned = false
  let refreshCount = 0

  while (Date.now() < deadline) {
    const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode ?? "")}`
    let status: StatusResponse
    try {
      const response = await fetch(url, {
        headers: { "iLink-App-ClientVersion": "1" },
        signal: AbortSignal.timeout(35_000),
      })
      status = await response.json() as StatusResponse
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") continue
      throw error
    }

    // 微信把该次登录导流到其他机房：后续轮询必须换成 redirect_host，
    // 否则会一直原地等待直到 8 分钟超时。
    if (status.status === "scaned_but_redirect" && status.redirect_host) {
      baseUrl = normalizeBaseUrl(status.redirect_host)
      continue
    }

    if (status.status === "scaned" && !scanned) {
      scanned = true
      console.log("已扫码，请在手机端确认……")
    }

    if (status.status === "expired") {
      if (refreshCount >= QR_REFRESH_MAX) {
        throw new Error(`二维码连续 ${QR_REFRESH_MAX} 次过期，请重新执行登录`)
      }
      refreshCount += 1
      qr = await fetchQrcode(baseUrl)
      scanned = false
      printQrcode(qr, `二维码已过期，已自动刷新（${refreshCount}/${QR_REFRESH_MAX}）：`)
      continue
    }

    if (status.status === "confirmed") {
      const accountId = saveAccount(status)
      console.log(`登录成功，账号：${accountId}`)
      console.log("请重启 wechat-mimocode-bot.service 载入新账号。")
      return
    }
    await Bun.sleep(1_000)
  }
  throw new Error("登录超时，请重试")
}

await main()
