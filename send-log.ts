/**
 * 发送日志仅记录摘要及投递标识，不输出协议令牌或媒体上传凭证。
 * @author Y77H
 * @date 2026-11-02
 */
export type SendLogDetails = {
  to: string
  account: string
  client: string
  type: string
  text: string
  source: string
  part?: string
}

/**
 * 生成单行日志；摘要最多160个字符，保留完整消息长度供排查。
 * @param details 接收对象、账号、消息ID、类型、正文与发送来源。
 * @param result 发送开始、成功、重试或失败。
 * @param attempt 当前尝试次数，尚未请求时为0。
 * @param elapsedMs 此次投递累计耗时（毫秒）。
 * @param error 失败原因，仅记录错误说明，不序列化请求对象。
 * @returns 包含摘要与投递上下文的单行日志。
 * @example formatSendLog(details, "成功", 1, 120)
 */
export function formatSendLog(
  details: SendLogDetails,
  result: "开始" | "成功" | "重试" | "失败",
  attempt = 0,
  elapsedMs = 0,
  error?: unknown,
): string {
  const compact = (text: string) => text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
  const text = compact(details.text)
  const chars = Array.from(text)
  const summary = chars.slice(0, 160).join("") + (chars.length > 160 ? "…" : "")
  const quoted = (text: string) => JSON.stringify(compact(text))
  const fields = [
    `[发送] 结果=${result}`,
    `来源=${quoted(details.source)}`,
    `对象=${quoted(details.to)}`,
    `发送账号=${quoted(details.account || "未确定")}`,
    `类型=${details.type}`,
    `分段=${details.part || "1/1"}`,
    `字数=${Array.from(details.text).length}`,
    `摘要=${JSON.stringify(summary)}`,
    `消息ID=${quoted(details.client)}`,
    `尝试=${attempt}/3`,
    `耗时=${elapsedMs}ms`,
  ]
  if (error !== undefined) fields.push(`原因=${quoted(compact(error instanceof Error ? error.message : String(error)).slice(0, 500))}`)
  return fields.join(" ")
}
