/**
 * 微信用户角色和 MiMoCode 工具权限的持久化存储。
 *
 * 管理命令只修改这个结构化文件，不接受任意 MiMoCode JSON，避免错误规则扩大权限。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs"
import { dirname, join, posix } from "path"

export const SAFE_USER_TOOLS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "lsp",
] as const

export type SafeUserTool = typeof SAFE_USER_TOOLS[number]
export type UserRole = "admin" | "user"

export interface UserAccess {
  role: UserRole
  tools: SafeUserTool[]
  paths: string[]
  updatedAt: number
}

interface AccessDocument {
  version: 1
  users: Record<string, UserAccess>
}

const DEFAULT_ACCESS_PATH = join(process.cwd(), "data", "access.json")
const BLOCKED_EXACT_PATHS = [
  "/",
  "/data",
]
const BLOCKED_PATH_TREES = [
  "/root",
  "/etc",
  "/usr",
  "/var",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/run",
]

function defaultUser(role: UserRole): UserAccess {
  return {
    role,
    tools: [...SAFE_USER_TOOLS],
    paths: [],
    updatedAt: Date.now(),
  }
}

function isSafeTool(value: string): value is SafeUserTool {
  return SAFE_USER_TOOLS.includes(value as SafeUserTool)
}

function normalizeUserAccess(value: unknown): UserAccess | null {
  if (!value || typeof value !== "object") return null
  const item = value as Partial<UserAccess>
  if (item.role !== "admin" && item.role !== "user") return null
  const tools = Array.isArray(item.tools)
    ? [...new Set(item.tools.filter((tool): tool is SafeUserTool =>
        typeof tool === "string" && isSafeTool(tool)
      ))]
    : [...SAFE_USER_TOOLS]
  const paths = Array.isArray(item.paths)
    ? [...new Set(item.paths.filter((path): path is string =>
        typeof path === "string" && path.startsWith("/")
      ).map((path) => posix.normalize(path)))]
    : []
  return {
    role: item.role,
    tools,
    paths,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
  }
}

export class AccessStore {
  private readonly path: string
  private data: AccessDocument = { version: 1, users: {} }

  constructor(
    knownUserIds: string[],
    configuredAdminUserId?: string,
    path = process.env.WECHAT_ACCESS_FILE ?? DEFAULT_ACCESS_PATH,
  ) {
    this.path = path
    this.load()

    for (const userId of knownUserIds) {
      if (!this.data.users[userId]) this.data.users[userId] = defaultUser("user")
    }

    // 首次迁移优先沿用 systemd 中明确配置的管理员，否则使用最早出现的用户。
    if (!this.hasAdmin()) {
      const bootstrapAdmin = configuredAdminUserId || knownUserIds[0]
      if (bootstrapAdmin) {
        this.data.users[bootstrapAdmin] = {
          ...(this.data.users[bootstrapAdmin] ?? defaultUser("admin")),
          role: "admin",
          updatedAt: Date.now(),
        }
      }
    }
    this.save()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<AccessDocument>
      if (parsed.version !== 1 || !parsed.users || typeof parsed.users !== "object") return
      const users: Record<string, UserAccess> = {}
      for (const [userId, value] of Object.entries(parsed.users)) {
        const normalized = normalizeUserAccess(value)
        if (normalized) users[userId] = normalized
      }
      this.data = { version: 1, users }
    } catch (error) {
      console.error(`[access] 配置读取失败，将使用安全默认值：${error}`)
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tempPath = `${this.path}.tmp`
    writeFileSync(tempPath, JSON.stringify(this.data, null, 2))
    renameSync(tempPath, this.path)
  }

  private hasAdmin(): boolean {
    return Object.values(this.data.users).some((user) => user.role === "admin")
  }

  ensureUser(userId: string): UserAccess {
    let access = this.data.users[userId]
    if (!access) {
      access = defaultUser(this.hasAdmin() ? "user" : "admin")
      this.data.users[userId] = access
      this.save()
    }
    return access
  }

  get(userId: string): UserAccess {
    return this.ensureUser(userId)
  }

  list(): Array<{ userId: string; access: UserAccess }> {
    return Object.entries(this.data.users)
      .map(([userId, access]) => ({ userId, access }))
      .sort((left, right) =>
        left.access.role === right.access.role
          ? left.userId.localeCompare(right.userId)
          : left.access.role === "admin" ? -1 : 1
      )
  }

  isAdmin(userId: string): boolean {
    return this.ensureUser(userId).role === "admin"
  }

  setRole(userId: string, role: UserRole): { ok: boolean; error?: string } {
    const current = this.ensureUser(userId)
    if (
      current.role === "admin"
      && role === "user"
      && this.list().filter((item) => item.access.role === "admin").length === 1
    ) {
      return { ok: false, error: "不能移除最后一名管理员" }
    }
    current.role = role
    current.updatedAt = Date.now()
    this.save()
    return { ok: true }
  }

  setTool(userId: string, tool: SafeUserTool, allowed: boolean): void {
    const access = this.ensureUser(userId)
    const tools = new Set(access.tools)
    if (allowed) tools.add(tool)
    else tools.delete(tool)
    access.tools = SAFE_USER_TOOLS.filter((candidate) => tools.has(candidate))
    access.updatedAt = Date.now()
    this.save()
  }

  setPath(userId: string, path: string, allowed: boolean): string {
    const normalized = AccessStore.validatePath(path)
    const access = this.ensureUser(userId)
    const paths = new Set(access.paths)
    if (allowed) paths.add(normalized)
    else paths.delete(normalized)
    access.paths = [...paths].sort()
    access.updatedAt = Date.now()
    this.save()
    return normalized
  }

  static isSafeTool(value: string): value is SafeUserTool {
    return isSafeTool(value)
  }

  static validatePath(value: string): string {
    const trimmed = value.trim()
    if (!trimmed.startsWith("/")) throw new Error("路径必须是 Linux 绝对路径")
    if (trimmed.split("/").includes("..")) throw new Error("路径不能包含 ..")
    const normalized = posix.normalize(trimmed).replace(/\/+$/, "") || "/"
    if (
      BLOCKED_EXACT_PATHS.includes(normalized)
      || BLOCKED_PATH_TREES.some((blocked) =>
        normalized === blocked || normalized.startsWith(`${blocked}/`)
      )
    ) {
      throw new Error(`不允许授权系统目录：${normalized}`)
    }
    return normalized
  }
}
