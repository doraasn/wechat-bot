#!/usr/bin/env bash
# 微信 MiMoCode Bot 管理脚本 — iLink 直连版

set -euo pipefail

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_PORT="${BOT_PORT:-3000}"
MIMO_SERVER_PORT="${MIMO_SERVER_PORT:-4096}"
PID_FILE="$BOT_DIR/.pid.bot"
LOG_FILE="$BOT_DIR/.wechat-bot.log"

export BOT_PORT
export WECHAT_ILINK_STATE_DIR="${WECHAT_ILINK_STATE_DIR:-$BOT_DIR/data/ilink}"

port_pid() {
  ss -lntp "sport = :$1" 2>/dev/null |
    sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' |
    head -n 1
}

start_services() {
  mkdir -p /data/work "$WECHAT_ILINK_STATE_DIR"
  if systemctl cat wechat-mimocode-bot.service &>/dev/null; then
    systemctl start mimocode-server.service wechat-mimocode-bot.service
    echo "✅ MiMo Server 与微信 Bot 已启动"
    return
  fi

  local mimo_pid bot_pid
  mimo_pid="$(port_pid "$MIMO_SERVER_PORT")"
  if [ -z "$mimo_pid" ]; then
    echo "❌ MiMo Server 未运行 :$MIMO_SERVER_PORT"
    exit 1
  fi
  bot_pid="$(port_pid "$BOT_PORT")"
  if [ -z "$bot_pid" ]; then
    cd "$BOT_DIR"
    setsid bun run bot-handler.ts </dev/null >>"$LOG_FILE" 2>&1 &
    echo "$!" >"$PID_FILE"
  fi
  echo "✅ 微信 Bot 已启动，直接连接 iLink"
}

stop_services() {
  if systemctl cat wechat-mimocode-bot.service &>/dev/null; then
    systemctl stop wechat-mimocode-bot.service
  else
    local pid
    pid="$(port_pid "$BOT_PORT")"
    [ -z "$pid" ] || kill "$pid"
    rm -f "$PID_FILE"
  fi
  echo "✅ 微信 Bot 已停止"
}

show_status() {
  echo "MiMo Server : $(port_pid "$MIMO_SERVER_PORT" || true)"
  echo "微信 Bot    : $(port_pid "$BOT_PORT" || true)"
  curl -fsS "http://127.0.0.1:$BOT_PORT/ilink/status" 2>/dev/null |
    python3 -m json.tool || echo "iLink 状态不可用"
}

do_login() {
  cd "$BOT_DIR"
  bun run ilink-login.ts
}

case "${1:-foreground}" in
  daemon) start_services ;;
  stop) stop_services ;;
  status) show_status ;;
  login) do_login ;;
  log)
    if systemctl cat wechat-mimocode-bot.service &>/dev/null; then
      journalctl -fu wechat-mimocode-bot.service
    else
      tail -f "$LOG_FILE"
    fi
    ;;
  foreground|"")
    mkdir -p /data/work "$WECHAT_ILINK_STATE_DIR"
    cd "$BOT_DIR"
    exec bun run bot-handler.ts
    ;;
  *)
    echo "用法: $0 [daemon|stop|status|login|log|foreground]"
    exit 1
    ;;
esac
