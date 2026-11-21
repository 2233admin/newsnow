import { Buffer } from "node:buffer"
import type { FeedCursor } from "./store"
import { InputError } from "#/registry/spec"

/**
 * 信息流查询参数的校验与规范化。HTTP（query string）与 MCP（JSON 入参）共用同一份，
 * 所以入参允许「字符串、数组、数字」几种写法。
 */

/**
 * 单页条数：默认 50、上限 200。待定：上限 200 是 D1 单条语句 100 个绑定参数之外的另一条约束，
 * 与采集的单源上限（collector/config.ts maxItemsPerSource）取同一个数，让一次响应不超过一个源一次采集的量级；
 * 一页 200 条的 JSON 约 60 KB（按标题 40 字、链接 80 字估），本机访问没有压力。没有按前端实测推出。
 */
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
/** 关键词最多几个词、每个词多长。待定：只为挡住拼出巨大 LIKE 条件的入参。 */
export const MAX_KEYWORDS = 5
export const MAX_KEYWORD_LENGTH = 64
const MAX_LIST = 100
const MAX_ITEM_LENGTH = 100

export interface FeedParams {
  /** 精确 id 或 `前缀*`（如 `user:*`）；空 = 不按来源限 */
  source: string[]
  category: string[]
  /** 标的（模块 5 富化后才有数据）；给了就返回空，并在响应里标明未实装 */
  symbol: string[]
  keywords: string[]
  from?: number
  to?: number
  since?: number
  limit: number
  cursor?: FeedCursor
  /** 把停用与已删除的源的历史条目也算进来 */
  includeInactive: boolean
}

type Raw = Record<string, unknown>

/** 字符串或数组 → 去空白、去重的字符串列表；字符串里的逗号也是分隔符。 */
function list(value: unknown, label: string, split = ","): string[] {
  if (value === undefined || value === null || value === "") return []
  const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => {
    if (typeof v !== "string") throw new InputError(`${label} 必须是字符串或字符串数组`)
    return split ? v.split(split) : [v]
  }).map(v => v.trim()).filter(Boolean)
  const unique = [...new Set(parts)]
  if (unique.length > MAX_LIST) throw new InputError(`${label} 最多 ${MAX_LIST} 项`)
  if (unique.some(v => v.length > MAX_ITEM_LENGTH)) throw new InputError(`${label} 的每一项最长 ${MAX_ITEM_LENGTH} 个字符`)
  return unique
}

/** 毫秒数（数字或数字串）或日期串（ISO 8601 等 Date.parse 认得的）。 */
export function timeParam(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  let ms: number
  if (typeof value === "number") ms = value
  else if (typeof value === "string") ms = /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value)
  else throw new InputError(`${label} 必须是毫秒时间戳或日期字符串`)
  if (!Number.isFinite(ms) || ms < 0) throw new InputError(`${label} 不是合法的时间`)
  return Math.floor(ms)
}

function bool(value: unknown) {
  return value === true || value === "1" || value === "true"
}

export function encodeCursor(c: FeedCursor) {
  return Buffer.from(JSON.stringify([c.feedTs, c.sourceId, c.itemId])).toString("base64url")
}

export function decodeCursor(raw: string): FeedCursor {
  try {
    const [feedTs, sourceId, itemId] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (Number.isFinite(feedTs) && typeof sourceId === "string" && typeof itemId === "string") return { feedTs, sourceId, itemId }
  } catch {}
  throw new InputError("cursor 无效，请用上一页响应里的 nextCursor 原样传回")
}

export function normalizeFeedParams(raw: Raw): FeedParams {
  const limitRaw = raw.limit
  let limit = DEFAULT_LIMIT
  if (limitRaw !== undefined && limitRaw !== null && limitRaw !== "") {
    limit = typeof limitRaw === "number" ? limitRaw : /^\d+$/.test(String(limitRaw)) ? Number(limitRaw) : Number.NaN
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new InputError(`limit 必须是 1 到 ${MAX_LIMIT} 的整数`)
  }
  // q：空白分隔的若干个词，每个词都要出现在标题里
  const keywords = list(raw.q, "q", "").flatMap(v => v.split(/\s+/)).filter(Boolean)
  if (keywords.length > MAX_KEYWORDS) throw new InputError(`q 最多 ${MAX_KEYWORDS} 个词`)
  if (keywords.some(k => k.length > MAX_KEYWORD_LENGTH)) throw new InputError(`q 的每个词最长 ${MAX_KEYWORD_LENGTH} 个字符`)
  const from = timeParam(raw.from, "from")
  const to = timeParam(raw.to, "to")
  if (from !== undefined && to !== undefined && from >= to) throw new InputError("from 必须早于 to")
  return {
    source: list(raw.source, "source"),
    category: list(raw.category, "category"),
    symbol: list(raw.symbol, "symbol"),
    keywords,
    from,
    to,
    since: timeParam(raw.since, "since"),
    limit,
    cursor: typeof raw.cursor === "string" && raw.cursor ? decodeCursor(raw.cursor) : undefined,
    includeInactive: bool(raw.includeInactive),
  }
}
