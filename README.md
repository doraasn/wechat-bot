# WeChat MiMoCode Bot

把微信消息接入 MiMoCode 的轻量 Bot。项目内置 iLink/ClawBot 协议客户端，直接连接微信，不依赖第三方 Bridge。机器人通过常驻 `mimo serve` 复用 MiMoCode 进程；每个微信用户使用独立目录和独立 session，支持排队、长期会话、上下文压缩、阶段性进度提示、Markdown 和微信“正在输入”状态。

## 功能

- 每个微信用户独立会话：`/data/work/<wechat-user-id>/`
- 普通消息按用户串行排队，并持久化到用户工作区；进程重启后自动恢复
- `/stop` 中断当前任务并清空队列，但保留长期会话
- `/compact` 原样发送给 MiMoCode，用于压缩上下文
- AI 回复末尾追加精简状态：时间、耗时、上下文占用、输入/输出 token
- MiMoCode 产生阶段性文本后立即推送到微信，不使用定时进度提醒
- 主动触发微信“正在输入”状态
- 原样发送 Markdown，支持微信表格、标题、粗体和引用渲染
- iLink 登录状态、同步游标和用户发送上下文持久化，重启后自动恢复
- 支持多个微信账号同时在线；再次扫码会追加账号，不再覆盖已有账号
- MiMoCode 使用完全免授权模式，强制权限事件由客户端静默批准；删除操作通过全局 `AGENTS.md` 要求先征得用户确认
- 通过 SSE 接收 MiMoCode 流式输出，`/stop` 会调用服务端中断接口

## 环境要求

- Linux / ARM64 或 x64
- Bun
- MiMoCode CLI：`mimo`
- 已通过 `bun run login` 登录微信 iLink
- 已配置 MiMoCode provider，例如 DeepSeek key

## 安装

```bash
bun install
```

## 启动

生产环境安装 `systemd/` 下的两个服务单元。MiMo Server 与微信 Bot
分别由 systemd 监督：

```bash
cp systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mimocode-server.service wechat-mimocode-bot.service
```

手动启动机器人前，需要保证 `mimo serve` 已监听 `127.0.0.1:4096`：

```bash
./start.sh daemon
```

查看状态：

```bash
./start.sh status
```

查看日志：

```bash
./start.sh log
```

登录微信：

```bash
./start.sh login
```

停止服务：

```bash
./start.sh stop
```

## 微信命令

```text
/help     查看所有可用命令
/stop     中断当前正在处理的回复，保留长期会话
/clear    清空当前用户历史，并在下次消息开启新会话
/stats    查看当前用户会话统计
/compact  发送 /compact 给 MiMoCode，让它压缩当前长期会话
```

`【提示】` 或 `[提示]` 开头的消息不会发送给 AI，也不会进入对话历史。

## 配置

可选环境变量：

```bash
MIMO_PROVIDER_ID=deepseek
MIMO_MODEL_ID=deepseek-v4-flash
MIMO_CONTEXT_LIMIT_TOKENS=1000000
MIMO_SERVER_URL=http://127.0.0.1:4096
MIMO_SERVER_PORT=4096
BOT_PORT=3000
WECHAT_ILINK_STATE_DIR=/data/projects/wechat-bot/data/ilink
```

DeepSeek 系列默认按 1M 上下文显示占用量。

微信账号、Token、同步游标和发送上下文保存在 `data/ilink/`，该目录不会提交到 Git。

## 不应提交到 GitHub 的内容

- `node_modules/`
- `.pid.*`
- `*.log`
- `.env*`
- `/data/work/*` 用户会话目录
- `/data/mimocode/data/auth.json`
- 微信登录态和 MiMoCode key
