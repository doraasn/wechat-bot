/**
 * 微信 iLink 扫码登录工具。
 *
 * 协议流程参考 weixin-clawbot-bridge（MIT License，Copyright (c) 2026
 * cooooooooooode），登录凭据仅保存到本机 data/ilink。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const BASE_URL = "https://ilinkai.weixin.qq.com"
const STATE_DIR =
  process.env.WECHAT_ILINK_STATE_DIR ??
  "/data/projects/wechat-bot/data/ilink"

type QrResponse = {
  qrcode?: string
  qrcode_img_content?: string
}

type StatusResponse = {
  status?: "wait" | "scaned" | "confirmed" | "expired"
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

async function fetchJson<T>(url: string, timeoutMs = 35_000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  const raw = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw}`)
  return JSON.parse(raw) as T
}

function saveAccount(status: StatusResponse): string {
  if (!status.ilink_bot_id || !status.bot_token) {
    throw new Error("登录成功响应缺少 ilink_bot_id 或 bot_token")
  }
  const accountId = status.ilink_bot_id.trim().replace(/[@.]/g, "-")
  const accountsDir = path.join(STATE_DIR, "accounts")
  mkdirSync(accountsDir, { recursive: true })
  writeFileSync(
    path.join(STATE_DIR, "accounts.json"),
    JSON.stringify([accountId], null, 2),
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
  const qrUrl = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`
  const qr = await fetchJson<QrResponse>(qrUrl, 15_000)
  if (!qr.qrcode || !qr.qrcode_img_content) {
    throw new Error("获取二维码失败：响应缺少二维码")
  }

  console.log("请使用微信扫描以下二维码并在手机端确认：")
  console.log(qr.qrcode_img_content)
  console.log("等待确认，最长 8 分钟……")

  const deadline = Date.now() + 8 * 60_000
  let scanned = false
  while (Date.now() < deadline) {
    const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`
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

    if (status.status === "scaned" && !scanned) {
      scanned = true
      console.log("已扫码，请在手机端确认……")
    }
    if (status.status === "expired") throw new Error("二维码已过期，请重新执行登录")
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
