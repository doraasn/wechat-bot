import { existsSync, readFileSync, writeFileSync } from "fs"

const CHANNEL_PATH = "node_modules/weixin-clawbot-bridge/src/channel.ts"
const ROUTES_PATH = "node_modules/weixin-clawbot-bridge/src/server/routes.ts"

function patchFile(path: string, patch: (source: string) => string): void {
  if (!existsSync(path)) {
    console.log(`[patch-bridge-typing] skip missing ${path}`)
    return
  }

  const before = readFileSync(path, "utf-8")
  const after = patch(before)
  if (after === before) {
    console.log(`[patch-bridge-typing] unchanged ${path}`)
    return
  }

  writeFileSync(path, after)
  console.log(`[patch-bridge-typing] patched ${path}`)
}

patchFile(CHANNEL_PATH, (source) => {
  let next = source

  if (!next.includes("typingTicket: string")) {
    next = next.replace(
      "  cdnBaseUrl: string\n}",
      "  cdnBaseUrl: string\n  typingTicket: string\n}",
    )
  }

  if (!next.includes("typingTicket: cached.typingTicket")) {
    next = next.replace(
      "          cdnBaseUrl: account.cdnBaseUrl,\n        })",
      "          cdnBaseUrl: account.cdnBaseUrl,\n          typingTicket: cached.typingTicket,\n        })",
    )
  }

  return next
})

patchFile(ROUTES_PATH, (source) => {
  let next = source

  if (!next.includes("../core/api/api.js")) {
    next = next.replace(
      'import { getSendContext, listSendContextUsers } from "../channel.js"\n',
      'import { getSendContext, listSendContextUsers } from "../channel.js"\nimport { sendTyping } from "../core/api/api.js"\nimport { TypingStatus } from "../core/api/types.js"\n',
    )
  }

  if (!next.includes('app.post("/api/typing"')) {
    const typingRoute = `  // --- Send typing indicator ---

  app.post("/api/typing", async (c) => {
    const body = await c.req.json<{ to?: string; status?: "start" | "stop" | "typing" | "cancel" | number }>()
    const to = body.to
    if (!to) return c.json({ error: "missing 'to' field" }, 400)

    const ctx = getSendContext(to)
    if (!ctx) {
      const users = listSendContextUsers()
      return c.json({
        error: \`no context for user '\${to}'. Available users: \${users.join(", ") || "(none yet - wait for first inbound message)"}\`,
      }, 404)
    }
    if (!ctx.typingTicket) return c.json({ error: \`no typing ticket for user '\${to}'\` }, 404)

    const status = body.status === "stop" || body.status === "cancel" || body.status === TypingStatus.CANCEL
      ? TypingStatus.CANCEL
      : TypingStatus.TYPING

    try {
      await sendTyping({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        body: { ilink_user_id: to, typing_ticket: ctx.typingTicket, status },
      })
      logger.info(\`[api/typing] sent to=\${to} status=\${status}\`)
      return c.json({ ok: true, to, status })
    } catch (err) {
      logger.error(\`[api/typing] error: \${err}\`)
      return c.json({ error: String(err) }, 500)
    }
  })

`
    next = next.replace("  // --- Send media (image/video/file) ---\n", `${typingRoute}  // --- Send media (image/video/file) ---\n`)
  }

  return next
})
