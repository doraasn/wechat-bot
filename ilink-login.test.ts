/**
 * 微信登录流程的行为验证。
 *
 * `scaned_but_redirect`（换机房）和 `expired`（二维码过期）无法用真实微信按需触发，
 * 因此起一个本地假 iLink 服务返回这些状态，真实执行 ilink-login.ts 观察它的行为。
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

type FakeIlink = {
  url: string
  statusRequests: () => number
  qrRequests: () => number
  stop: () => void
}

/** 假 iLink 服务：按队列依次返回状态，队列耗尽后一直返回 wait。 */
function startFakeIlink(statuses: Record<string, unknown>[]): FakeIlink {
  const queue = [...statuses]
  let statusRequests = 0
  let qrRequests = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/ilink/bot/get_bot_qrcode") {
        qrRequests += 1
        return Response.json({
          qrcode: `qr-${qrRequests}`,
          qrcode_img_content: `QR-${qrRequests}`,
        })
      }
      if (url.pathname === "/ilink/bot/get_qrcode_status") {
        statusRequests += 1
        return Response.json(queue.shift() ?? { status: "wait" })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    statusRequests: () => statusRequests,
    qrRequests: () => qrRequests,
    stop: () => server.stop(true),
  }
}

async function runLogin(
  baseUrl: string,
  stateDir: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", path.join(import.meta.dir, "ilink-login.ts")], {
    env: {
      ...process.env,
      WECHAT_ILINK_BASE_URL: baseUrl,
      WECHAT_ILINK_STATE_DIR: stateDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const guard = setTimeout(() => proc.kill(), 20_000)
  const exitCode = await proc.exited
  clearTimeout(guard)
  return { exitCode, stdout: await new Response(proc.stdout).text() }
}

function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "ilink-login-"))
  return run(stateDir).finally(() => rmSync(stateDir, { recursive: true, force: true }))
}

describe("ilink-login", () => {
  test("遇到 scaned_but_redirect 时切换到 redirect_host 继续轮询", async () => {
    const target = startFakeIlink([{
      status: "confirmed",
      bot_token: "token-a",
      ilink_bot_id: "bot-a@im.bot",
      ilink_user_id: "user-a",
    }])
    const entry = startFakeIlink([{ status: "scaned_but_redirect", redirect_host: target.url }])
    try {
      await withStateDir(async (stateDir) => {
        const { exitCode } = await runLogin(entry.url, stateDir)
        expect(exitCode).toBe(0)
        // 重定向后的域名上确实发生了轮询，并据此完成了登录
        expect(target.statusRequests()).toBeGreaterThan(0)
        expect(existsSync(path.join(stateDir, "accounts", "bot-a-im-bot.json"))).toBe(true)
      })
    } finally {
      entry.stop()
      target.stop()
    }
  })

  test("二维码过期时自动换新码，而不是直接退出", async () => {
    const server = startFakeIlink([
      { status: "expired" },
      { status: "confirmed", bot_token: "token-b", ilink_bot_id: "bot-b@im.bot", ilink_user_id: "user-b" },
    ])
    try {
      await withStateDir(async (stateDir) => {
        const { exitCode, stdout } = await runLogin(server.url, stateDir)
        expect(server.qrRequests()).toBeGreaterThanOrEqual(2)
        expect(stdout).toContain("已自动刷新")
        expect(exitCode).toBe(0)
        expect(existsSync(path.join(stateDir, "accounts", "bot-b-im-bot.json"))).toBe(true)
      })
    } finally {
      server.stop()
    }
  })

  test("连续过期超过上限时明确失败", async () => {
    const server = startFakeIlink([
      { status: "expired" },
      { status: "expired" },
      { status: "expired" },
      { status: "expired" },
    ])
    try {
      await withStateDir(async (stateDir) => {
        const { exitCode, stdout } = await runLogin(server.url, stateDir)
        expect(exitCode).not.toBe(0)
        expect(stdout).toContain("过期")
      })
    } finally {
      server.stop()
    }
  })
})
