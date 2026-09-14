#!/usr/bin/env bash
# 微信语音 → 文字
#
# 用法: voice2text.sh <音频文件>        # 支持 .silk / .wav / .mp3 / .amr / .m4a 等
# 输出: 识别文本（纯文本，stdout）；失败时非 0 退出并把原因写到 stderr
#
# 管线: 微信 .silk →（silk-v3-decoder）→ 24k PCM →（ffmpeg）→ 16k 单声道 wav
#                              →（whisper.cpp）→ 简体中文文本
#
# 依赖（均已装在 /data/apps，不占系统盘）:
#   /data/apps/silk-v3-decoder   SILK 解码器 + silk2wav.sh
#   /data/apps/ffmpeg            音频转码
#   /data/apps/whisper.cpp       whisper-cli
#   /data/apps/whisper-models    ggml 模型
#
# 可用环境变量覆盖:
#   WHISPER_MODEL    模型路径（默认 ggml-base-q5_1.bin，约 19s/条；换 ggml-tiny-q5_1.bin 约 8s 但准确度低）
#   WHISPER_LANG     语言（默认 zh）
#   WHISPER_THREADS  线程数（默认 4）
#   WHISPER_PROMPT   提示词（默认简体中文 + 领域词，可显著减少繁体输出）
set -euo pipefail

SILK2WAV="/data/apps/silk-v3-decoder/silk2wav.sh"
FFMPEG="/usr/local/bin/ffmpeg"
WHISPER_BIN="/data/apps/whisper.cpp/build/bin/whisper-cli"
WHISPER_MODEL="${WHISPER_MODEL:-/data/apps/whisper-models/ggml-base-q5_1.bin}"
WHISPER_LANG="${WHISPER_LANG:-zh}"
WHISPER_THREADS="${WHISPER_THREADS:-4}"
WHISPER_PROMPT="${WHISPER_PROMPT:-以下是普通话语音消息的简体中文转写，内容涉及食堂菜单、待办事项和工时记录。}"

if [ $# -lt 1 ]; then
  echo "用法: $0 <音频文件>" >&2
  exit 64
fi

INPUT="$1"
[ -f "$INPUT" ] || { echo "文件不存在: $INPUT" >&2; exit 66; }

for tool in "$FFMPEG" "$WHISPER_BIN" "$WHISPER_MODEL"; do
  [ -e "$tool" ] || { echo "缺少依赖: $tool" >&2; exit 69; }
done

WORKDIR=$(mktemp -d -t voice2text.XXXXXX)
trap 'rm -rf "$WORKDIR"' EXIT
WAV="$WORKDIR/audio16k.wav"

case "${INPUT,,}" in
  *.silk)
    [ -x "$SILK2WAV" ] || { echo "缺少依赖: $SILK2WAV" >&2; exit 69; }
    "$SILK2WAV" "$INPUT" "$WAV" > /dev/null
    ;;
  *)
    "$FFMPEG" -y -i "$INPUT" -ar 16000 -ac 1 "$WAV" > /dev/null 2>&1
    ;;
esac

[ -s "$WAV" ] || { echo "音频解码失败: $INPUT" >&2; exit 1; }

"$WHISPER_BIN" \
  -m "$WHISPER_MODEL" \
  -f "$WAV" \
  -l "$WHISPER_LANG" \
  -t "$WHISPER_THREADS" \
  --no-timestamps \
  --prompt "$WHISPER_PROMPT" \
  2> /dev/null | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e '/^$/d'
