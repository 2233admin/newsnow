import { Buffer } from "node:buffer"
import type { FeedCursor } from "./store"
import { SYMBOL_ID } from "#/enrich/symbols"
import { marketOfSymbol } from "#/enrich/align"
import { DIRECTIONS, MARKETS } from "#/enrich/types"
import type { Direction, Market } from "#/enrich/types"
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
  /** 标的，品种 id「代码.场所」（600519.XSHG、AAPL.XNAS、BTCUSDT.BINANCE）；条目或它所在组的任一成员带其中之一就命中 */
  symbol: string[]
  keywords: string[]
  from?: number
  to?: number
  since?: number
  limit: number
  cursor?: FeedCursor
  /** 把停用与已删除的源的历史条目也算进来 */
  includeInactive: boolean
  /** 展开：同一事件的多条报道每条单独出现；默认每组只出主条目一行 */
  expand: boolean
  /**
   * 市场（cn / us / crypto）：只要按这个市场对齐过交易日的条目；与 tradeDate / tradeDateFrom / tradeDateTo 一起用时，是「这个市场的这些交易日」。
   * 给了 symbol 与交易日条件却没给 market 时，由标的的场所推出（600519.XSHG → cn，AAPL.XNAS → us，BTCUSDT.BINANCE → crypto），
   * 标的各自只匹配自己市场的对齐：K 线上点（交易日，标的）不会取到「这个标的在另一个市场的交易日」凑巧相同的新闻。
   */
  market?: Market
  /** 交易日 YYYY-MM-DD：条目在某个市场里对齐到这一天（给了 market 就限定在那个市场） */
  tradeDate?: string
  /** 交易日区间的起点（含），与 market 配合；口径同 tradeDate（按对齐的交易日，不是发布时间戳） */
  tradeDateFrom?: string
  /** 交易日区间的终点（含） */
  tradeDateTo?: string
  /** 影响类型（分类表里的名称，见 GET /api/feed/meta）；组的标注命中其中之一 */
  impact: string[]
  /** 方向：positive / negative / neutral（对新闻本身的读法，不是涨跌预测）；组的标注命中其中之一 */
  direction: Direction[]
  /** 题材（tags.themes 里的名称，整串精确匹配）；组的标注命中其中之一 */
  theme: string[]
  /** 含规则层过滤掉的（荐股软文、榜单水文、广告、行情罗列）；默认不含 */
  includeFiltered: boolean
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

/** 标的：转大写、去重，格式须是「代码.场所」（不认裸代码：同一个六位数在沪深可能是两只）。 */
function symbols(value: unknown): string[] {
  const out = list(value, "symbol").map(v => v.toUpperCase())
  for (const v of out) {
    if (!SYMBOL_ID.test(v)) throw new InputError(`symbol「${v}」要写成「代码.场所」，如 600519.XSHG、AAPL.XNAS、BTCUSDT.BINANCE`)
  }
  return [...new Set(out)]
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

/** YYYY-MM-DD，且是真实存在的日期（2026-02-30 不行）。 */
function tradeDateParam(value: unknown, label = "tradeDate"): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const v = typeof value === "string" ? value.trim() : ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new InputError(`${label} 要写成 YYYY-MM-DD 的有效日期，如 2026-11-30`)
  }
  return v
}

/**
 * 交易日条件里没给 market、但给了 symbol：由标的的场所推出市场。
 * 标的都推得出且同属一个市场 → 用它；跨了多个市场 → 拒绝（一个交易日只在一个市场里有意义，请带 market 或按市场分开查）；
 * 有场所不认识 → 不推（保持原样：任一市场对齐到这天的都算）。
 */
function inferMarket(symbols: string[]): Market | undefined {
  const markets = new Set<Market | undefined>(symbols.map(s => marketOfSymbol(s)))
  if (!markets.size || markets.has(undefined)) return undefined
  if (markets.size > 1) throw new InputError("symbol 跨了多个市场，而交易日是各市场自己的：请带 market，或按市场分开查")
  return [...markets][0]
}

function marketParam(value: unknown): Market | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const v = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (!(MARKETS as readonly string[]).includes(v)) throw new InputError(`market 必须是 ${MARKETS.join(" / ")} 之一`)
  return v as Market
}

function directions(value: unknown): Direction[] {
  const out = list(value, "direction").map(v => v.toLowerCase())
  for (const v of out) {
    if (!(DIRECTIONS as readonly string[]).includes(v)) throw new InputError(`direction「${v}」必须是 ${DIRECTIONS.join(" / ")}（正面 / 负面 / 中性，对新闻本身的读法）之一`)
  }
  return [...new Set(out)] as Direction[]
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
  const symbol = symbols(raw.symbol)
  let market = marketParam(raw.market)
  const tradeDate = tradeDateParam(raw.tradeDate)
  const tradeDateFrom = tradeDateParam(raw.tradeDateFrom, "tradeDateFrom")
  const tradeDateTo = tradeDateParam(raw.tradeDateTo, "tradeDateTo")
  if (tradeDateFrom && tradeDateTo && tradeDateFrom > tradeDateTo) throw new InputError("tradeDateFrom 不能晚于 tradeDateTo")
  if (!market && symbol.length && (tradeDate || tradeDateFrom || tradeDateTo)) market = inferMarket(symbol)
  return {
    source: list(raw.source, "source"),
    category: list(raw.category, "category"),
    symbol,
    keywords,
    from,
    to,
    since: timeParam(raw.since, "since"),
    limit,
    cursor: typeof raw.cursor === "string" && raw.cursor ? decodeCursor(raw.cursor) : undefined,
    includeInactive: bool(raw.includeInactive),
    expand: bool(raw.expand),
    market,
    tradeDate,
    tradeDateFrom,
    tradeDateTo,
    impact: list(raw.impact, "impact"),
    direction: directions(raw.direction),
    theme: list(raw.theme, "theme"),
    includeFiltered: bool(raw.includeFiltered),
  }
}
