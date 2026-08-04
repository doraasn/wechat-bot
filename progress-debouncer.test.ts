import { describe, expect, test } from "bun:test"
import { ProgressDebouncer } from "./progress-debouncer"

describe("ProgressDebouncer", () => {
  test("合并静默窗口内的消息并重新计时", async () => {
    const sent: string[] = []
    const progress = new ProgressDebouncer(30, async (text) => { sent.push(text) })

    progress.push("第一段")
    await Bun.sleep(20)
    progress.push("第二段")
    await Bun.sleep(20)
    expect(sent).toEqual([])
    await Bun.sleep(20)
    expect(sent).toEqual(["第一段\n第二段"])
  })

  test("最终回复到达时丢弃尚未发送的进度", async () => {
    const sent: string[] = []
    const progress = new ProgressDebouncer(30, async (text) => { sent.push(text) })

    progress.push("不会发送")
    await progress.discardAndWait()
    await Bun.sleep(40)
    expect(sent).toEqual([])
  })
})
