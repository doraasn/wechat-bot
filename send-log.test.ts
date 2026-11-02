import { describe, expect, test } from "bun:test"
import { ILinkClient } from "./ilink-client"
import { formatSendLog, type SendLogDetails } from "./send-log"

const details: SendLogDetails = { to: "recipient-1", account: "bot-1", client: "delivery-1", type: "文本", text: "午餐提醒\n今天吃面", source: "主动推送" }

describe("发送日志", () => {
  test("包含对象、摘要、账号、投递标识和失败原因，并防止换行伪造记录", () => {
    const log = formatSendLog(details, "失败", 3, 120, new Error("prepare failed\n错误详情"))
    for (const value of ['对象="recipient-1"', '发送账号="bot-1"', '摘要="午餐提醒 今天吃面"', '消息ID="delivery-1"', '来源="主动推送"', '尝试=3/3', '耗时=120ms', '原因="prepare failed 错误详情"']) expect(log).toContain(value)
    expect(log).not.toContain("\n")
  })

  test("摘要截断保留完整字数且不拆开emoji", () => {
    const log = formatSendLog({ ...details, text: "😀".repeat(170) }, "成功", 1)
    expect(log).toContain('摘要="' + "😀".repeat(160) + '…"')
    expect(log).toContain("字数=170")
  })

  test("实际发送流程记录开始、业务失败重试和成功，不记录context或账号token", async () => {
    const logs: string[] = []
    const originalLog = console.log
    const originalSleep = Bun.sleep
    const client = new ILinkClient()
    type Harness = {
      contexts: Map<string, unknown>
      contextAccountId: () => string
      request: () => Promise<unknown>
    }
    const harness = client as unknown as Harness
    harness.contexts.set("recipient-1", { contextToken: "SECRET-CONTEXT", accountId: "bot-1" })
    harness.contextAccountId = () => "bot-1"
    let calls = 0
    harness.request = async () => ++calls === 1 ? { ret: -2, errmsg: "prepare failed" } : { ret: 0 }
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")) }
    Bun.sleep = (async () => {}) as typeof Bun.sleep
    try {
      await client.sendText("recipient-1", "午餐提醒", "delivery-1", "主动推送")
    } finally {
      console.log = originalLog
      Bun.sleep = originalSleep
    }
    expect(calls).toBe(2)
    expect(logs).toHaveLength(3)
    expect(logs[0]).toContain("结果=开始")
    expect(logs[1]).toContain("结果=重试")
    expect(logs[2]).toContain("结果=成功")
    for (const log of logs) {
      expect(log).toContain('对象="recipient-1"')
      expect(log).toContain('摘要="午餐提醒"')
      expect(log).not.toContain("SECRET-CONTEXT")
    }
  })

  test("发送前缺少上下文也记录对象和摘要，不尝试请求外部接口", async () => {
    const client = new ILinkClient()
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")) }
    try {
      await expect(client.sendText("unknown-test-recipient", "测试摘要")).rejects.toThrow("缺少 context_token")
    } finally {
      console.log = originalLog
    }
    expect(logs[0]).toContain('对象="unknown-test-recipient"')
    expect(logs[0]).toContain('摘要="测试摘要"')
    expect(logs[0]).toContain("结果=失败")
  })
})
