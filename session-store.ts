/**
 * Per-user persistent session store.
 * Each WeChat user gets their own directory under /data/work/<userId>/.
 *
 * Directory structure:
 *   /data/work/<userId>/
 *     ├── session.json    — conversation history
 *     ├── config.json     — per-user settings (extensible)
 *     └── media/          — received media files
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from "fs"
import { join } from "path"

const WORK_DIR = process.env.MIMO_WORK_DIR ?? "/data/work"

export interface Session {
  userId: string
  history: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>
  createdAt: number
  updatedAt: number
  metadata: Record<string, unknown>
}

export interface UserConfig {
  userId: string
  nickname?: string
  avatar?: string
  enabled: boolean
  model?: string
  systemPrompt?: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface QueuedMessage {
  id: string
  text: string
  receivedAt: number
  startedAt?: number
}

export class SessionStore {
  private cache = new Map<string, Session>()

  constructor() {
    this.loadAll()
  }

  /** Ensure user directory exists under /data/work/ */
  private ensureUserDir(userId: string): string {
    const dir = join(WORK_DIR, this.sanitize(userId))
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, "media"), { recursive: true })
    return dir
  }

  private userDir(userId: string): string {
    return join(WORK_DIR, this.sanitize(userId))
  }

  private sessionPath(userId: string): string {
    return join(this.userDir(userId), "session.json")
  }

  private configPath(userId: string): string {
    return join(this.userDir(userId), "config.json")
  }

  private queuePath(userId: string): string {
    return join(this.userDir(userId), "queue.json")
  }

  /** Write JSON atomically so a power loss cannot leave a half-written state file. */
  private writeJson(path: string, value: unknown): void {
    const tempPath = `${path}.tmp`
    writeFileSync(tempPath, JSON.stringify(value, null, 2))
    renameSync(tempPath, path)
  }

  private sanitize(userId: string): string {
    return userId.replace(/[^a-zA-Z0-9_\-.@]/g, "_")
  }

  /** Load all sessions from /data/work/ subdirectories */
  private loadAll(): void {
    let entries: string[] = []
    try {
      entries = readdirSync(WORK_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return // WORK_DIR may not exist yet
    }
    for (const dirName of entries) {
      const sessionFile = join(WORK_DIR, dirName, "session.json")
      if (!existsSync(sessionFile)) continue
      try {
        const data = readFileSync(sessionFile, "utf-8")
        const session: Session = JSON.parse(data)
        this.cache.set(session.userId, session)
      } catch {
        // skip corrupted files
      }
    }
  }

  // ─── Session operations ──────────────────────────────────────

  getOrCreate(userId: string): Session {
    let session = this.cache.get(userId)
    if (!session) {
      this.ensureUserDir(userId)
      try {
        const data = readFileSync(this.sessionPath(userId), "utf-8")
        const loaded = JSON.parse(data) as Session
        session = loaded
        this.cache.set(userId, loaded)
      } catch {
        const created: Session = {
          userId,
          history: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: {},
        }
        session = created
        this.cache.set(userId, created)
        this.save(userId)
      }
    }
    return session
  }

  save(userId: string): void {
    const session = this.cache.get(userId)
    if (!session) return
    session.updatedAt = Date.now()
    const dir = this.ensureUserDir(userId)
    this.writeJson(join(dir, "session.json"), session)
  }

  addMessage(userId: string, role: "user" | "assistant", content: string): void {
    const session = this.getOrCreate(userId)
    session.history.push({ role, content, timestamp: Date.now() })
    this.save(userId)
  }

  getHistory(userId: string, limit = 100): Array<{ role: string; content: string }> {
    const session = this.getOrCreate(userId)
    return session.history.slice(-limit).map(({ role, content }) => ({ role, content }))
  }

  clear(userId: string): void {
    const session = this.getOrCreate(userId)
    session.history = []
    this.save(userId)
  }

  listUsers(): string[] {
    return [...this.cache.keys()]
  }

  stats(userId: string): { historyCount: number; createdAt: string; updatedAt: string } | null {
    const session = this.cache.get(userId)
    if (!session) return null
    return {
      historyCount: session.history.length,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
    }
  }

  // ─── Per-user config ─────────────────────────────────────────

  getConfig(userId: string): UserConfig {
    const cfgPath = this.configPath(userId)
    try {
      const data = readFileSync(cfgPath, "utf-8")
      return JSON.parse(data) as UserConfig
    } catch {
      const cfg: UserConfig = {
        userId,
        enabled: true,
        metadata: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      this.saveConfig(userId, cfg)
      return cfg
    }
  }

  saveConfig(userId: string, cfg: UserConfig): void {
    cfg.updatedAt = Date.now()
    const dir = this.ensureUserDir(userId)
    this.writeJson(join(dir, "config.json"), cfg)
  }

  /** Load the durable per-user queue. Invalid entries are ignored. */
  loadQueue(userId: string): QueuedMessage[] {
    try {
      const data = JSON.parse(readFileSync(this.queuePath(userId), "utf-8"))
      if (!Array.isArray(data)) return []
      return data.filter((item): item is QueuedMessage =>
        typeof item?.id === "string"
        && typeof item?.text === "string"
        && typeof item?.receivedAt === "number"
        && (item?.startedAt === undefined || typeof item.startedAt === "number")
      )
    } catch {
      return []
    }
  }

  /** Persist the queue before acknowledging an inbound webhook. */
  saveQueue(userId: string, queue: QueuedMessage[]): void {
    const dir = this.ensureUserDir(userId)
    this.writeJson(join(dir, "queue.json"), queue)
  }

  /** Get the media directory for a user */
  mediaDir(userId: string): string {
    const dir = this.ensureUserDir(userId)
    return join(dir, "media")
  }

  /** Get the full user directory path */
  userPath(userId: string): string {
    return this.ensureUserDir(userId)
  }
}

export const sessions = new SessionStore()
