# WeChat MiMoCode Bot

把微信消息接入 MiMoCode 的轻量 Bot。项目内置 iLink/ClawBot 协议客户端，直接连接微信，不依赖第三方 Bridge。机器人通过常驻 `mimo serve` 复用 MiMoCode 进程；每个微信用户使用独立目录和独立 session，支持排队、长期会话、上下文压缩、阶段性进度提示、Markdown 和微信“正在输入”状态。

## 功能

- 每个微信用户独立会话：`/data/work/<wechat-user-id>/`
- 普通消息按用户串行排队，并持久化到用户工作区；进程重启后自动恢复
- `/stop` 中断当前任务并清空队列，但保留长期会话
- `/compact` 原样发送给 MiMoCode，用于压缩上下文
- 默认不设置任务超时，长任务持续等待，直到完成或用户发送 `/stop`
- 无参数命令后可直接追加下一条要求，例如 `/stop 检查最新日志`
- AI 回复末尾追加精简状态：时间、耗时、上下文占用、输入/输出 token
- MiMoCode 阶段性文本按静默窗口合并；窗口内有新内容就重新计时，最终回复到达时直接丢弃未发送进度
- 合并时把阶段文本末尾表示“待续”的中英文冒号改成句号，正文内部标点保持不变
- 最终回复校验微信业务回执并使用固定消息 ID 重试；多次失败时持久化等待重发，不会重新执行 MiMoCode 任务
- 主动触发微信“正在输入”状态
- 原样发送 Markdown，支持微信表格、标题、粗体和引用渲染
- 接收图片、视频、语音和普通文件，按用户与日期归档到 `attachments/YYYY-MM-DD/`
- AI 可用 `[发送文件](相对路径)` 标记把工作目录中的图片、表格或其他文件作为微信附件发回
- iLink 登录状态、同步游标和用户发送上下文持久化，重启后自动恢复
- 支持多个微信账号同时在线；再次扫码会追加账号，不再覆盖已有账号
- 首位微信用户为管理员；后续用户只能使用文件工具访问自己的 `/data/work/<用户>/` 目录
- 管理员使用完全免授权模式；普通用户使用会话级目录白名单；删除操作通过全局 `AGENTS.md` 要求先征得用户确认
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

管理员还可以直接在微信中维护角色和受限用户权限：

```text
/admin-help
/users
/role <用户ID> admin|user
/permissions <用户ID>
/allow-tool <用户ID> read|edit|glob|grep|list|lsp
/deny-tool <用户ID> read|edit|glob|grep|list|lsp
/allow-path <用户ID> <Linux绝对路径>
/deny-path <用户ID> <Linux绝对路径>
```

权限配置持久化到 `data/access.json`。Bot 不接受任意 MiMoCode JSON；角色或权限改变时会中断目标用户的当前任务并清空其排队消息，下一次请求自动使用新权限，同时保留 MiMoCode 上下文。

`【提示】` 或 `[提示]` 开头的消息不会发送给 AI，也不会进入对话历史。

## 配置

可选环境变量：

```bash
MIMO_PROVIDER_ID=deepseek
MIMO_MODEL_ID=deepseek-v4-flash
MIMO_CONTEXT_LIMIT_TOKENS=1000000
MIMO_SERVER_URL=http://127.0.0.1:4096
MIMO_SERVER_PORT=4096
MIMO_REQUEST_TIMEOUT_MS=0
BOT_PORT=3000
WECHAT_ILINK_STATE_DIR=/data/projects/wechat-bot/data/ilink
WECHAT_ADMIN_USER_ID=首位微信用户的_iLink_ID
WECHAT_ACCESS_FILE=/data/projects/wechat-bot/data/access.json
WECHAT_MEDIA_MAX_BYTES=104857600
WECHAT_PROGRESS_DEBOUNCE_MS=15000
WECHAT_DELIVERY_RETRY_DELAY_MS=30000
```

DeepSeek 系列默认按 1M 上下文显示占用量。

`MIMO_REQUEST_TIMEOUT_MS=0` 表示不限制单次任务时长。设置为正整数时，单位为毫秒。

`WECHAT_PROGRESS_DEBOUNCE_MS` 是阶段性输出的静默合并窗口；窗口内每次出现新内容都会重新计时。`WECHAT_DELIVERY_RETRY_DELAY_MS` 是最终回复经过接口内三次重试后仍发送失败时，持久化队列再次尝试投递的间隔。

微信账号、Token、同步游标和发送上下文保存在 `data/ilink/`，该目录不会提交到 Git。

## 附件

微信收到的附件会保存到：

```text
/data/work/<微信用户ID>/attachments/YYYY-MM-DD/
```

归档文件名包含接收时间、消息 ID 和原文件名，重名时自动增加序号。默认单个附件最大 100MB。
MiMoCode 会收到附件的绝对路径，可以直接读取图片、Excel、PDF 等文件。

如果 MiMoCode 需要把生成结果作为微信附件发回，最终回复中使用：

```markdown
[发送文件](outputs/result.xlsx)
```

路径可使用相对于当前用户工作目录的路径或绝对路径，但真实文件（包括符号链接目标）必须位于该用户工作目录内。

## 不应提交到 GitHub 的内容

- `node_modules/`
- `.pid.*`
- `*.log`
- `.env*`
- `/data/work/*` 用户会话目录
- `/data/mimocode/data/auth.json`
- 微信登录态和 MiMoCode key
