#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 微信 ClawBot 启动脚本 — 斐讯 N1
# ─────────────────────────────────────────────────────────────
# 启动方式:
#   ./start.sh              — 前台启动 (调试)
#   ./start.sh daemon       — 后台守护进程
#   ./start.sh stop         — 停止服务
#   ./start.sh status       — 查看状态
#   ./start.sh login        — 扫码登录微信
#   ./start.sh log          — 查看日志
# ─────────────────────────────────────────────────────────────

set -e

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_PORT=${BOT_PORT:-3000}
BRIDGE_PORT=${BRIDGE_PORT:-3200}
PID_FILE="$BOT_DIR/.pid"
LOG_FILE="$BOT_DIR/.wechat-bot.log"
BRIDGE_LOG="$BOT_DIR/.bridge.log"

export BOT_PORT

# ── Ensure work directories exist ──────────────────────────────
mkdir -p /data/work

ensure_config() {
  local cfg_dir="${HOME}/.weixin-clawbot-bridge"
  mkdir -p "$cfg_dir"
  if [ ! -f "$cfg_dir/config.json" ]; then
    cat > "$cfg_dir/config.json" <<-EOF
{
  "adapter": "webhook",
  "port": $BRIDGE_PORT,
  "webhook": {
    "endpoint": "http://127.0.0.1:$BOT_PORT/webhook"
  }
}
EOF
    echo "  [配置] 已创建 $cfg_dir/config.json"
  fi
}

port_pid() {
  ss -lntp "sport = :$1" 2>/dev/null |
    sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' |
    head -n 1
}

# ── Start ──────────────────────────────────────────────────────
start_services() {
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  微信 ClawBot — Bot Handler + Bridge            ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""
  ensure_config

  # Start bot handler (port BOT_PORT)
  bot_pid=$(port_pid "$BOT_PORT")
  if [ -n "$bot_pid" ]; then
    echo "  [1/2] Bot Handler 已运行 :$BOT_PORT (PID $bot_pid)"
    echo "$bot_pid" > "$PID_FILE.bot"
  else
    echo "  [1/2] 启动 Bot Handler :$BOT_PORT ..."
    cd "$BOT_DIR"
    setsid bun run bot-handler.ts </dev/null >> "$LOG_FILE" 2>&1 &
    echo "$!" > "$PID_FILE.bot"
    sleep 2
  fi

  # Start bridge (port BRIDGE_PORT)
  bridge_pid=$(port_pid "$BRIDGE_PORT")
  if [ -n "$bridge_pid" ]; then
    echo "  [2/2] Bridge 已运行 :$BRIDGE_PORT (PID $bridge_pid)"
    echo "$bridge_pid" > "$PID_FILE.bridge"
  else
    echo "  [2/2] 启动 Bridge :$BRIDGE_PORT ..."
    setsid bun run 'node_modules/weixin-clawbot-bridge/src/cli/index.ts' start \
      --adapter webhook \
      --endpoint "http://127.0.0.1:$BOT_PORT/webhook" \
      --port $BRIDGE_PORT \
      </dev/null >> "$BRIDGE_LOG" 2>&1 &
    echo "$!" > "$PID_FILE.bridge"
    sleep 2
  fi

  echo ""
  echo "  ✅ 服务已启动"
  echo "  📡 Bot Handler: http://127.0.0.1:$BOT_PORT"
  echo "  🔗 Bridge     : http://127.0.0.1:$BRIDGE_PORT"
  echo "  📝 日志: $LOG_FILE"
  echo ""
  echo "  登录微信: ./start.sh login"
  echo "  查看状态: ./start.sh status"
  echo "  停止服务: ./start.sh stop"
}

# ── Do Login ────────────────────────────────────────────────────
do_login() {
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  微信扫码登录                                    ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""

  # Check if bridge is running
  if [ ! -f "$PID_FILE.bridge" ] || ! kill -0 $(cat "$PID_FILE.bridge") 2>/dev/null; then
    echo "  ⚠️  Bridge 未运行，请先执行 ./start.sh"
    exit 1
  fi

  echo "  请求二维码..."
  echo ""

  # Get QR code from bridge API
  QR_RESP=$(curl -s -X POST http://127.0.0.1:$BRIDGE_PORT/api/login/qr)
  QR_URL=$(echo "$QR_RESP" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$QR_URL" ]; then
    echo "  ❌ 获取二维码失败: $QR_RESP"
    exit 1
  fi

  echo "  📱 请使用微信扫描以下二维码:"
  echo ""
  echo "  $QR_URL"
  echo ""

  # Also try to generate a QR code image if possible
  if command -v qrencode &>/dev/null; then
    echo "  ┌──────────────────────────────────────────┐"
    qrencode -t ANSI -o - "$QR_URL" 2>/dev/null || true
    echo "  └──────────────────────────────────────────┘"
    echo ""
  fi

  echo "  等待扫码确认 (最长等待 8 分钟)..."
  echo "  扫描后手机端点击「确认登录」即可"
  echo ""

  # Poll for login status
  for i in $(seq 1 480); do
    STATUS=$(curl -s http://127.0.0.1:$BRIDGE_PORT/api/login/status 2>/dev/null || echo '{"phase":"unknown"}')
    PHASE=$(echo "$STATUS" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)

    case "$PHASE" in
      "qr")
        if [ $((i % 10)) -eq 0 ]; then
          echo -n "."
        fi
        ;;
      "scanned")
        echo ""
        echo "  ✅ 已扫码! 请在手机上确认登录..."
        echo -n "  等待确认"
        for j in $(seq 1 10); do echo -n "."; sleep 1; done
        echo ""
        ;;
      "confirmed")
        echo ""
        echo "  ✅ 登录成功!"
        break
        ;;
      "expired")
        echo ""
        echo "  ❌ 二维码已过期，请重新运行 ./start.sh login"
        exit 1
        ;;
      *)
        echo -n "."
        ;;
    esac
    sleep 1
  done

  echo ""
  echo "  📋 当前账号:"
  curl -s http://127.0.0.1:$BRIDGE_PORT/api/account | python3 -m json.tool 2>/dev/null || \
  curl -s http://127.0.0.1:$BRIDGE_PORT/api/account
  echo ""
}

# ── Stop ────────────────────────────────────────────────────────
stop_services() {
  echo "  停止服务..."
  for item in "bridge:$BRIDGE_PORT" "bot:$BOT_PORT"; do
    name=${item%%:*}
    port=${item##*:}
    file="$PID_FILE.$name"
    pid=$(port_pid "$port")
    if [ -z "$pid" ] && [ -f "$file" ]; then
      pid=$(cat "$file")
    fi
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  done
  echo "  ✅ 已停止"
}

# ── Status ──────────────────────────────────────────────────────
show_status() {
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  服务状态                                        ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""

  local bot_alive=false
  local bridge_alive=false
  bot_pid=$(port_pid "$BOT_PORT")
  bridge_pid=$(port_pid "$BRIDGE_PORT")

  if [ -n "$bot_pid" ]; then
    bot_alive=true
    echo "$bot_pid" > "$PID_FILE.bot"
  fi
  if [ -n "$bridge_pid" ]; then
    bridge_alive=true
    echo "$bridge_pid" > "$PID_FILE.bridge"
  fi
  echo "  🧠 MiMoCode CLI: $(mimo --version 2>/dev/null || echo '❌ 未安装')"
  echo "  📡 Bot Handler: $($bot_alive && echo '✅ 运行中' || echo '❌ 未运行')"
  echo "  🔗 Bridge     : $($bridge_alive && echo '✅ 运行中' || echo '❌ 未运行')"
  echo ""

  if $bridge_alive; then
    echo "  微信账号:"
    curl -s http://127.0.0.1:$BRIDGE_PORT/api/account 2>/dev/null | python3 -m json.tool 2>/dev/null || \
    echo "    (无法获取账号信息)"
    echo ""
  fi

  echo "  活跃会话:"
  curl -s http://127.0.0.1:$BOT_PORT/admin/users 2>/dev/null | python3 -m json.tool 2>/dev/null || \
  echo "    (无法获取会话信息)"
  echo ""
}

# ── Logs ────────────────────────────────────────────────────────
show_logs() {
  tail -f "$LOG_FILE" "$BRIDGE_LOG" 2>/dev/null || echo "日志文件不存在"
}

# ── Main ────────────────────────────────────────────────────────
case "${1:-foreground}" in
  daemon)
    start_services
    ;;
  stop)
    stop_services
    ;;
  status)
    show_status
    ;;
  login)
    do_login
    ;;
  log)
    show_logs
    ;;
  foreground|"")
    echo "  前台启动 (Ctrl+C 停止)..."
    ensure_config
    echo "  [1/2] 启动 Bot Handler ..."
    cd "$BOT_DIR"
    bun run bot-handler.ts &
    BOT_PID=$!
    sleep 2
    echo "  [2/2] 启动 Bridge ..."
    bun run 'node_modules/weixin-clawbot-bridge/src/cli/index.ts' start \
      --adapter webhook \
      --endpoint "http://127.0.0.1:$BOT_PORT/webhook" \
      --port $BRIDGE_PORT
    kill $BOT_PID 2>/dev/null || true
    ;;
  *)
    echo "用法: $0 [daemon|stop|status|login|log|foreground]"
    echo ""
    echo "  (无参数)  — 前台启动 (调试)"
    echo "  daemon    — 后台启动"
    echo "  stop      — 停止服务"
    echo "  status    — 查看状态"
    echo "  login     — 扫码登录微信"
    echo "  log       — 查看日志"
    exit 1
    ;;
esac
