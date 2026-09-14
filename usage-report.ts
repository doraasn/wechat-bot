/**
 * 会话状态行里的用量信息：缓存命中率、本次消费、DeepSeek 余额。
 *
 * - 命中率与消费：来自 MiMo Server 上报的 token 用量；单价从
 *   `/config/providers` 实时读取（models.dev 口径，美元/百万 token），
 *   乘以汇率换算成人民币，与余额币种保持一致。
 * - 余额：DeepSeek 官方 `/user/balance`，按接口返回的币种原样展示。
 * - 两者都属于"锦上添花"：服务重启、断网、接口变更时直接省略对应字段，
 *   绝不影响正文回复。
 */
import { readFileSync } from "fs"
import type { MimoUsage } from "./mimo-integration"

const MIMO_SERVER_URL = process.env.MIMO_SERVER_URL ?? "http://127.0.0.1:4096"
const DEFAULT_PROVIDER_ID = process.env.MIMO_PROVIDER_ID ?? "deepseek"
const DEFAULT_MODEL_ID = process.env.MIMO_MODEL_ID ?? "deepseek-v4-flash"
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "")
// 单价表是美元口径，余额接口是人民币口径；换算率可随汇率调整。
const USD_TO_CNY = Number.parseFloat(process.env.BOT_USD_CNY_RATE ?? "7.1")
const PRICING_CACHE_TTL_MS = 10 * 60_000
const BALANCE_CACHE_TTL_MS = 60_000
const PRICING_REQUEST_TIMEOUT_MS = 5_000
const BALANCE_REQUEST_TIMEOUT_MS = 3_000

type UsageModel = {
  providerID?: string
  modelID?: string
}

type Pricing = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type RawCost = {
  input?: number
  output?: number
  cache?: {
    read?: number
    write?: number
  }
}

function resolveModel(model?: UsageModel): { providerID: string; modelID: string } {
  return {
    providerID: model?.providerID ?? DEFAULT_PROVIDER_ID,
    modelID: model?.modelID ?? DEFAULT_MODEL_ID,
  }
}

/** DeepSeek 官方取价需要 API Key，优先用环境变量，其次复用 MiMoCode 的登录凭据。 */
function deepseekApiKey(): string | undefined {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const home = process.env.MIMOCODE_HOME ?? "/data/mimocode"
  try {
    const auth = JSON.parse(readFileSync(`${home}/data/auth.json`, "utf8")) as Record<string, { key?: string }>
    return auth.deepseek?.key?.trim() || undefined
  } catch {
    return undefined
  }
}

async function fetchPricing(
  providerID: string,
  modelID: string,
  cwd: string,
): Promise<Pricing | undefined> {
  try {
    const url = new URL("/config/providers", `${MIMO_SERVER_URL.replace(/\/+$/, "")}/`)
    url.searchParams.set("directory", cwd)
    const response = await fetch(url, { signal: AbortSignal.timeout(PRICING_REQUEST_TIMEOUT_MS) })
    if (!response.ok) return undefined
    const data = await response.json() as {
      providers?: { id?: string; models?: Record<string, { cost?: RawCost }> }[]
    }
    const model = data.providers
      ?.find((provider) => provider.id === providerID)
      ?.models?.[modelID]
    const cost = model?.cost
    if (!cost) return undefined
    return {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cache?.read ?? 0,
      cacheWrite: cost.cache?.write ?? 0,
    }
  } catch {
    return undefined
  }
}

let pricingTask: { key: string; promise: Promise<Pricing | undefined>; at: number } | undefined

function resolvePricing(providerID: string, modelID: string, cwd: string): Promise<Pricing | undefined> {
  const key = `${providerID}/${modelID}`
  if (pricingTask?.key === key && Date.now() - pricingTask.at < PRICING_CACHE_TTL_MS) {
    return pricingTask.promise
  }
  const task = { key, promise: fetchPricing(providerID, modelID, cwd), at: Date.now() }
  pricingTask = task
  return task.promise
}

function currencySymbol(currency?: string): string {
  if (currency === "CNY") return "¥"
  if (currency === "USD") return "$"
  return currency ?? ""
}

async function fetchBalance(): Promise<string | undefined> {
  const key = deepseekApiKey()
  if (!key) return undefined
  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/user/balance`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(BALANCE_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const data = await response.json() as {
      balance_infos?: { currency?: string; total_balance?: string }[]
    }
    const info = data.balance_infos?.[0]
    if (!info?.total_balance) return undefined
    const amount = Number.parseFloat(info.total_balance)
    if (!Number.isFinite(amount)) return undefined
    return `${currencySymbol(info.currency)} ${amount.toFixed(2)}`
  } catch {
    return undefined
  }
}

let balanceTask: { promise: Promise<string | undefined>; at: number } | undefined

function resolveBalance(): Promise<string | undefined> {
  if (balanceTask && Date.now() - balanceTask.at < BALANCE_CACHE_TTL_MS) return balanceTask.promise
  const task = { promise: fetchBalance(), at: Date.now() }
  balanceTask = task
  return task.promise
}

function formatCost(value: number): string {
  if (value >= 0.00005) return value.toFixed(4)
  if (value > 0) return "<0.0001"
  return "0"
}

/**
 * 缓存命中率按"本次提问全部提示词"统计：多步对话里第一步必然未命中，
 * 用累计口径才能反映这次对话真实的缓存收益。
 */
function cacheHitRate(usage: MimoUsage): number | undefined {
  const prompt = usage.cacheRead + usage.input
  if (prompt <= 0) return undefined
  return (usage.cacheRead / prompt) * 100
}

function estimateCostCNY(usage: MimoUsage, pricing: Pricing): number {
  const usdPerMillion =
    usage.input * pricing.input +
    (usage.output + usage.reasoning) * pricing.output +
    usage.cacheRead * pricing.cacheRead +
    usage.cacheWrite * pricing.cacheWrite
  return (usdPerMillion / 1_000_000) * USD_TO_CNY
}

export type UsageSummary = {
  /** 缓存命中率，如 "83.9%" */
  hitRate?: string
  /** 本次消费金额（不含货币符号），如 "0.0797" */
  cost?: string
  /** 账户余额，如 "¥ 317.93" */
  balance?: string
}

/** 状态表格的列顺序，表头与数据行共用。 */
const STATUS_COLUMNS = ["耗时", "消费", "余额", "命中率", "上下文", "时间"]

/** 把状态数据渲染成 Markdown 表格；空字符串表示该项取不到、留空单元格。 */
export function formatStatusTable(cells: string[]): string {
  return [
    `| ${STATUS_COLUMNS.join(" | ")} |`,
    `|${STATUS_COLUMNS.map(() => " --- ").join("|")}|`,
    `| ${cells.join(" | ")} |`,
  ].join("\n")
}

/** 采集状态行需要的用量数据，任一项取不到就留空。 */
export async function describeUsage(
  model: UsageModel | undefined,
  usage: MimoUsage | undefined,
  cwd: string,
): Promise<UsageSummary> {
  const resolved = resolveModel(model)
  const [balance, pricing] = await Promise.all([
    resolveBalance(),
    usage ? resolvePricing(resolved.providerID, resolved.modelID, cwd) : Promise.resolve(undefined),
  ])

  const rate = usage ? cacheHitRate(usage) : undefined
  return {
    hitRate: rate === undefined ? undefined : `${rate.toFixed(1)}%`,
    cost: usage && pricing ? formatCost(estimateCostCNY(usage, pricing)) : undefined,
    balance,
  }
}
