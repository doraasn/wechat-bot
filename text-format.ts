/** 将阶段性文本末尾表示“待续”的冒号改成完整句号，不改正文内部标点。 */
export function normalizeTrailingColon(text: string): string {
  return text.replace(/[：:]([\t ]*)$/, "。$1")
}
