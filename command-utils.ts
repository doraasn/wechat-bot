const CHAINABLE_COMMANDS = new Set([
  "/help",
  "/admin-help",
  "/stop",
  "/clear",
  "/stats",
  "/compact",
  "/users",
])

/**
 * 无参数命令后可以直接追加下一条自然语言要求。
 * 例如 `/stop 检查最新日志` 会先中断，再把“检查最新日志”加入队列。
 */
export function splitChainedCommand(text: string): {
  command: string
  followUp: string
} | null {
  const match = text.trim().match(/^(\/\S+)\s+([\s\S]+)$/)
  const command = match?.[1]?.toLowerCase()
  const followUp = match?.[2]?.trim()
  if (!command || !followUp || !CHAINABLE_COMMANDS.has(command)) return null
  return { command, followUp }
}
