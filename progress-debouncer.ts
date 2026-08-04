import { normalizeTrailingColon } from "./text-format"

/**
 * 合并 MiMoCode 的阶段性输出；只有静默达到指定时间后才推送。
 * 最终回复到达时可直接丢弃尚未发送的阶段性内容。
 */
export class ProgressDebouncer {
  private readonly parts: string[] = []
  private timer?: ReturnType<typeof setTimeout>
  private sendChain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly delayMs: number,
    private readonly send: (text: string) => Promise<void>,
  ) {}

  push(text?: string): void {
    const value = text ? normalizeTrailingColon(text.trim()) : ""
    if (!value || this.closed) return
    this.parts.push(value)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }

  /** 最终回复已经到达：取消计时并丢弃尚未发送的进度。 */
  async discardAndWait(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.parts.length = 0
    await this.sendChain
  }

  private flush(): void {
    this.timer = undefined
    if (this.closed || !this.parts.length) return
    const text = this.parts.splice(0).join("\n").trim()
    if (!text) return
    this.sendChain = this.sendChain
      .then(() => this.send(text))
      .catch((error) => console.log(`[progress] send failed: ${error}`))
  }
}
