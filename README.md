# WeChat MiMoCode Bot

把微信消息接入 MiMoCode 的轻量 Bot。每个微信用户使用独立目录和独立 MiMoCode session，支持排队、长期会话、上下文压缩、阶段性进度提示和微信“正在输入”状态。

## 功能

- 每个微信用户独立会话：`/data/work/<wechat-user-id>/`
- 普通消息串行排队，不丢消息
- `/stop` 中断当前任务并清空队列，但保留长期会话
- `/compact` 原样发送给 MiMoCode，用于压缩上下文
- AI 回复末尾追加精简状态：时间、耗时、上下文占用、输入/输出 token
- 长任务每 30 分钟提示一次，预览只发送新增内容
- 主动触发微信“正在输入”状态

## 环境要求

- Linux / ARM64 或 x64
- Bun
- MiMoCode CLI：`mimo`
- 已登录 `weixin-clawbot-bridge`
- 已配置 MiMoCode provider，例如 DeepSeek key

## 安装

```bash
bun install
```

安装后会自动运行：

```bash
bun run scripts/patch-bridge-typing.ts
```

这个脚本会给 `weixin-clawbot-bridge` 增加 `/api/typing`，用于后台任务期间维持微信“正在输入”。

## 启动

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
BOT_PORT=3000
```

DeepSeek 系列默认按 1M 上下文显示占用量。

## 不应提交到 GitHub 的内容

- `node_modules/`
- `.pid.*`
- `*.log`
- `.env*`
- `/data/work/*` 用户会话目录
- `/root/.local/share/mimocode/auth.json`
- 微信登录态和 MiMoCode key
