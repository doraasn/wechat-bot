#!/usr/bin/env bash
# MiMoCode Server + 微信 Bot 重启脚本
# 用法:
#   bash scripts/restart-mimo.sh            # 重启正式服务 (4096)
#   bash scripts/restart-mimo.sh 4099       # 用指定端口重启（测试验证用）
#   bash scripts/restart-mimo.sh --test     # 测试模式：临时起一个小 server 验证重启逻辑
#
# 说明:
#   - 正式模式通过 systemd 重启 mimocode-server.service + wechat-mimocode-bot.service
#   - 测试模式在同一端口起一个临时 mimo serve 进程，验证端口能起来就退出
#   - 重启后微信 Bot 会自动重连（MIMO_SERVER_URL 端口不变）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-4096}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

wait_port() {
  local port="$1" timeout="${2:-60}"
  for i in $(seq 1 "$timeout"); do
    if curl -fsS "http://127.0.0.1:${port}/session" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

is_systemd_service() {
  systemctl cat "$1" &>/dev/null
}

case "${1:-}" in
  --test)
    # 测试模式：验证重启逻辑（不碰正式服务）
    TEST_PORT="${2:-4097}"
    log "测试模式：启动临时 mimo serve 于端口 $TEST_PORT"
    # 先确保端口空闲
    if ss -lntp 2>/dev/null | grep -q ":$TEST_PORT "; then
      log "端口 $TEST_PORT 被占用，退出"
      exit 1
    fi
    (cd /data/work && mimo serve --hostname 127.0.0.1 --port "$TEST_PORT" >/tmp/mimo-restart-test.log 2>&1 &)
    if wait_port "$TEST_PORT" 30; then
      log "✅ 测试成功：端口 $TEST_PORT 已就绪"
      # 清理测试进程
      pkill -f "mimo serve --hostname 127.0.0.1 --port $TEST_PORT" 2>/dev/null || true
      exit 0
    else
      log "❌ 测试失败：端口 $TEST_PORT 30 秒内未就绪"
      tail -20 /tmp/mimo-restart-test.log
      exit 1
    fi
    ;;
esac

# ===== 正式模式 =====
log "=== 重启 MiMoCode Server (端口 $PORT) ==="

if is_systemd_service mimocode-server.service; then
  log "通过 systemd 重启 mimocode-server.service"
  systemctl restart mimocode-server.service
else
  log "systemd 无该服务，直接 kill 后重启"
  pkill -f "mimo serve --hostname 127.0.0.1 --port $PORT" 2>/dev/null || true
  sleep 2
  (cd /data/work && mimo serve --hostname 127.0.0.1 --port "$PORT" >>/tmp/mimo-server.log 2>&1 &)
fi

if wait_port "$PORT" 90; then
  log "✅ MiMoCode Server 已就绪 (端口 $PORT)"
else
  log "❌ MiMoCode Server 90 秒内未就绪"
  journalctl -u mimocode-server --no-pager -n 20 2>/dev/null || tail -20 /tmp/mimo-server.log 2>/dev/null || true
  exit 1
fi

# 重启微信 Bot（正式端口才需要）
if [ "$PORT" = "4096" ] && is_systemd_service wechat-mimocode-bot.service; then
  log "重启 wechat-mimocode-bot.service"
  systemctl restart wechat-mimocode-bot.service
  sleep 3
  if systemctl is-active --quiet wechat-mimocode-bot.service; then
    log "✅ 微信 Bot 已重启"
  else
    log "❌ 微信 Bot 重启失败"
    exit 1
  fi
fi

log "=== 全部完成 ==="
