/**
 * 微信语音转写：调用本地 voice2text.sh（SILK 解码 + ffmpeg + whisper.cpp），
 * 把语音内容变成文本，让不支持音频的会话模型也能"听懂"语音消息。
 *
 * 微信/iLink 有时会直接下发语音的转写文字（voice_item.text），那种情况走原有路径、
 * 不会下载语音附件；这里是缺失时的兜底。仅覆盖"语音消息"这一种附件类型，
 * 用户按普通文件发来的音频不做自动转写。
 *
 * 未配置 WECHAT_VOICE2TEXT、脚本不存在或转写失败时返回 null，不阻塞也不报错，
 * 保持原有的"只给附件路径"行为。
 */
export async function transcribeVoice(filePath: string): Promise<string | null> {
  const script = process.env.WECHAT_VOICE2TEXT
  if (!script) return null
  if (!(await Bun.file(script).exists())) {
    console.log(`[voice] 转写脚本不存在: ${script}`)
    return null
  }

  const timeoutMs = parseInt(process.env.WECHAT_VOICE2TEXT_TIMEOUT_MS ?? "180000", 10)
  const proc = Bun.spawn([script, filePath], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)

  try {
    const [text, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      console.log(`[voice] 转写失败 code=${code}: ${error.trim().slice(0, 200)}`)
      return null
    }
    const transcript = text.trim()
    if (!transcript) {
      console.log("[voice] 转写结果为空")
      return null
    }
    console.log(`[voice] 转写完成 chars=${transcript.length}`)
    return transcript
  } catch (err) {
    console.log(`[voice] 转写异常: ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
