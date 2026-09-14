/**
 * iLink 会话过期（errcode -14）行为的真实验证。
 *
 * 用本地假服务返回微信真实的过期响应体 `{"errcode":-14,"errmsg":"session timeout"}`，
 * 观察 monitorLoop 是否停止高频重试 —— 真实接口无法按需制造 token 过期。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ILinkClient } from "./ilink-client"

function startFakeIlink(response: Record<string, unknown>) {
  let requests = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/getupdates")) {
        requests += 1
        return Response.json(response)
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests: () => requests,
    stop: () => server.stop(true),
  }
}

function seedAccount(stateDir: string, baseUrl: string): void {
  mkdirSync(path.join(stateDir, "accounts"), { recursive: true })
  writeFileSync(path.join(stateDir, "accounts.json"), JSON.stringify(["bot-x-im-bot"]))
  writeFileSync(
    path.join(stateDir, "accounts", "bot-x-im-bot.json"),
    JSON.stringify({ token: "token-x", baseUrl, userId: "user-x" }),
  )
}

async function withClient(
  response: Record<string, unknown>,
  observe: (server: ReturnType<typeof startFakeIlink>) => Promise<void>,
): Promise<void> {
  const server = startFakeIlink(response)
  const stateDir = mkdtempSync(path.join(tmpdir(), "ilink-session-"))
  seedAccount(stateDir, server.url)
  const previous = process.env.WECHAT_ILINK_STATE_DIR
  process.env.WECHAT_ILINK_STATE_DIR = stateDir
  const client = new ILinkClient()
  try {
    await client.start(async () => {}, () => stateDir)
    await observe(server)
  } finally {
    await client.stop()
    if (previous === undefined) delete process.env.WECHAT_ILINK_STATE_DIR
    else process.env.WECHAT_ILINK_STATE_DIR = previous
    server.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
}

describe("iLink 会话过期处理", () => {
  test("errcode=-14 时暂停轮询，不再按退避连续重试", async () => {
    await withClient({ ret: 0, errcode: -14, errmsg: "session timeout" }, async (server) => {
      await Bun.sleep(6_000)
      // 未被处理时 6 秒内会按 2 秒退避发出 3 次以上请求；暂停后只应发 1 次
      expect(server.requests()).toBe(1)
    })
  }, 25_000)

  test("普通错误仍按退避重试（对照组）", async () => {
    await withClient({ ret: -1, errcode: -2, errmsg: "other error" }, async (server) => {
      await Bun.sleep(6_000)
      expect(server.requests()).toBeGreaterThan(1)
    })
  }, 25_000)
})
