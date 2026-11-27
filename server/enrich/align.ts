import { logger } from "../utils/logger"
import calendarData from "./config/calendar.json"
import sourceMarketData from "./config/source-markets.json"
import { ConfigError, isRecord, need, resolveConfig } from "./config"
import { MARKETS } from "./types"
import type { Align, Market, Session } from "./types"

/**
 * 对齐交易日（#2188 补充）：每条新闻按它涉及的市场，给出落在哪个交易日、哪个时段。
 * 结构参照 owengetinfo-design/PokieTicker 的 backend/pipeline/alignment.py（MIT License，Copyright (c) 2025 PokieTicker）里
 * 「把发布时间顺延到最近的交易日」的做法（`_shift_to_trade_day`）；那份对着 OHLC 的日期集合找下一个交易日，这里没有行情数据，
 * 改成按「周末 + 休市日列表」推交易日，并加上时段与时区。代码是照这个思路重写的，不是逐行翻译。
 *
 * 规则（A 股 Asia/Shanghai；美股 America/New_York；时段区间都是左闭右开）：
 * - 交易日（非周末、非休市日）：开盘前 pre，tradeDate = 当天；盘中 open；两段盘中之间（A 股 11:30–13:00）lunch；收盘及以后 post，tradeDate = 下一个交易日。
 * - 非交易日（周末、休市日）：session = closed，tradeDate = 下一个交易日。
 * - crypto：24/7，tradeDate = 配置时区（默认 UTC）的自然日，session 一律 open。
 * - 美股提前收盘日（calendar.json 的 earlyClose）收盘时间取表里的值，之后算 post。
 * 时段边界与休市日的出处写在 config/calendar.json 里。calendar.json 没列出的年份只按周末算，日志警告一次。
 */

export const MARKET_LABELS: Record<Market, string> = { cn: "A 股", us: "美股", crypto: "加密币" }

const DATE = /^\d{4}-\d{2}-\d{2}$/
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

interface MarketCalendar {
  venues: string[]
  timezone: string
  /** 盘中时段（秒，自零点起），左闭右开，按时间升序；没有 = 24/7 */
  windows: [start: number, end: number][]
  years: Set<number>
  closed: Set<string>
  /** 日期 → 提前收盘的秒数 */
  earlyClose: Map<string, number>
}

export interface Calendar {
  markets: Record<Market, MarketCalendar>
}

export interface SourceMarkets {
  default: Market
  rules: { prefix: boolean, key: string, market: Market }[]
}

function seconds(hhmm: string) {
  const m = CLOCK.exec(hhmm)
  need(m, `时刻「${hhmm}」须写成 HH:MM`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60
}

function validDate(s: unknown, label: string): string {
  need(typeof s === "string" && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), `${label}「${String(s)}」须是 YYYY-MM-DD 的有效日期`)
  return s
}

const MS_PER_DAY = 86_400_000
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * MS_PER_DAY).toISOString().slice(0, 10)
function isWeekend(date: string) {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay()
  return d === 0 || d === 6
}

export function parseCalendar(raw: unknown): Calendar {
  need(isRecord(raw) && isRecord(raw.markets), "calendar.json 缺少 markets")
  const out = {} as Record<Market, MarketCalendar>
  for (const market of MARKETS) {
    const m = raw.markets[market]
    need(isRecord(m), `calendar.json 缺少市场 ${market}`)
    need(Array.isArray(m.venues) && m.venues.every(v => typeof v === "string" && /^[A-Z]{3,12}$/.test(v)), `${market}.venues 须是大写场所代码数组`)
    need(typeof m.timezone === "string", `${market}.timezone 须是 IANA 时区名`)
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: m.timezone }).format(0)
    } catch {
      throw new ConfigError(`${market}.timezone「${m.timezone}」不是有效的时区`)
    }
    const windows: [number, number][] = []
    if (m.open !== undefined) {
      need(Array.isArray(m.open) && m.open.length > 0, `${market}.open 须是非空数组`)
      for (const w of m.open) {
        need(Array.isArray(w) && w.length === 2, `${market}.open 的每项须是 [开始, 结束]`)
        const [a, b] = [seconds(w[0]), seconds(w[1])]
        need(a < b, `${market}.open 的 ${w[0]}–${w[1]} 开始须早于结束`)
        windows.push([a, b])
      }
      windows.sort((x, y) => x[0] - y[0])
      for (let i = 1; i < windows.length; i++) need(windows[i - 1][1] <= windows[i][0], `${market}.open 的时段不能重叠`)
    }
    const closed = new Set<string>()
    for (const c of (m.closed ?? []) as unknown[]) {
      need(isRecord(c), `${market}.closed 的每项须是对象`)
      const from = validDate(c.from, `${market}.closed.from`)
      const to = validDate(c.to, `${market}.closed.to`)
      need(from <= to, `${market}.closed 的 ${from} 晚于 ${to}`)
      for (let d = from; d <= to; d = addDays(d, 1)) closed.add(d)
    }
    const earlyClose = new Map<string, number>()
    if (m.earlyClose !== undefined) {
      need(isRecord(m.earlyClose), `${market}.earlyClose 须是 日期 → 时刻 的对象`)
      need(windows.length > 0, `${market} 没有 open 时段，不能有 earlyClose`)
      for (const [d, t] of Object.entries(m.earlyClose)) {
        validDate(d, `${market}.earlyClose 的日期`)
        const s = seconds(t as string)
        need(s > windows.at(-1)![0], `${market}.earlyClose ${d} 的收盘时间 ${String(t)} 不能早于最后一个时段的开始`)
        earlyClose.set(d, s)
      }
    }
    const years = new Set<number>()
    for (const y of (m.years ?? []) as unknown[]) {
      need(Number.isInteger(y), `${market}.years 须是整数数组`)
      years.add(y as number)
    }
    out[market] = { venues: m.venues as string[], timezone: m.timezone as string, windows, years, closed, earlyClose }
  }
  const seen = new Map<string, Market>()
  for (const market of MARKETS) {
    for (const v of out[market].venues) {
      need(!seen.has(v), `场所 ${v} 同时属于 ${seen.get(v)} 与 ${market}`)
      seen.set(v, market)
    }
  }
  return { markets: out }
}

export function parseSourceMarkets(raw: unknown): SourceMarkets {
  need(isRecord(raw), "source-markets.json 须是对象")
  need(MARKETS.includes(raw.default as Market), `source-markets.json 的 default 须是 ${MARKETS.join(" / ")} 之一`)
  need(Array.isArray(raw.sources ?? []), "source-markets.json 的 sources 须是数组")
  const rules = ((raw.sources ?? []) as unknown[]).map((r) => {
    need(isRecord(r) && typeof r.match === "string" && r.match.length > 0, "sources 的每项须有 match")
    need(MARKETS.includes(r.market as Market), `sources 里「${String(r.match)}」的 market 须是 ${MARKETS.join(" / ")} 之一`)
    const prefix = (r.match as string).endsWith("*")
    return { prefix, key: prefix ? (r.match as string).slice(0, -1) : (r.match as string), market: r.market as Market }
  })
  return { default: raw.default as Market, rules }
}

/** 已经警告过「没覆盖这一年」的（市场:年），每个只警告一次。 */
const warnedYears = new Set<string>()
let calendar: Calendar | undefined
let sourceMarkets: SourceMarkets | undefined

/** 进程内用的日历与来源默认市场（读一次；改了配置要重启）。 */
export function getCalendar(): Calendar {
  return calendar ??= resolveConfig("calendar", calendarData, parseCalendar)
}
export function getSourceMarkets(): SourceMarkets {
  return sourceMarkets ??= resolveConfig("source-markets", sourceMarketData, parseSourceMarkets)
}
/** 测试用：丢掉缓存，下次重新读配置。 */
export function resetAlignConfig() {
  calendar = undefined
  sourceMarkets = undefined
  warnedYears.clear()
}

// ---- 本地时间

const formatters = new Map<string, Intl.DateTimeFormat>()
function parts(ts: number, timeZone: string) {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    formatters.set(timeZone, f)
  }
  const p: Record<string, string> = {}
  for (const x of f.formatToParts(ts)) p[x.type] = x.value
  return { date: `${p.year}-${p.month}-${p.day}`, secs: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) }
}

function warnUncovered(market: Market, date: string, cal: MarketCalendar) {
  const year = Number(date.slice(0, 4))
  if (cal.years.has(year) || cal.windows.length === 0) return
  const key = `${market}:${year}`
  if (warnedYears.has(key)) return
  warnedYears.add(key)
  logger.warn(`enrich align：${market} 的休市日表（calendar.json）没有覆盖 ${year} 年，这一年只按周末算交易日；补上休市日并把 ${year} 加进 years。`)
}

/** 这一天开市吗（非周末、非休市日）；24/7 的市场总是开。 */
export function isTradingDay(date: string, market: Market, cal: Calendar = getCalendar()): boolean {
  const m = cal.markets[market]
  if (m.windows.length === 0) return true
  return !isWeekend(date) && !m.closed.has(date)
}

/** 严格晚于 date 的下一个交易日。 */
export function nextTradingDay(date: string, market: Market, cal: Calendar = getCalendar()): string {
  let d = date
  // 最长的连休是春节 + 周末 9–11 天；留足余量，万一配置把整年都标成休市也不死循环
  for (let i = 0; i < 60; i++) {
    d = addDays(d, 1)
    if (isTradingDay(d, market, cal)) return d
  }
  return d
}

/** 时间戳（毫秒）在某个市场里对应的交易日与时段。 */
export function alignAt(ts: number, market: Market, cal: Calendar = getCalendar()): Align {
  const m = cal.markets[market]
  const { date, secs } = parts(ts, m.timezone)
  if (m.windows.length === 0) return { market, tradeDate: date, session: "open" }
  warnUncovered(market, date, m)
  if (!isTradingDay(date, market, cal)) return { market, tradeDate: nextTradingDay(date, market, cal), session: "closed" }
  const windows = m.windows.map((w, i) => (i === m.windows.length - 1 && m.earlyClose.has(date) ? [w[0], m.earlyClose.get(date)!] as [number, number] : w))
  let session: Session
  if (secs < windows[0][0]) session = "pre"
  else if (secs >= windows.at(-1)![1]) session = "post"
  else session = windows.some(([a, b]) => secs >= a && secs < b) ? "open" : "lunch"
  return { market, tradeDate: session === "post" ? nextTradingDay(date, market, cal) : date, session }
}

// ---- 一条新闻涉及哪些市场

/** 标的 id（「代码.场所」）的场所 → 市场；不认识的场所返回 undefined。 */
export function marketOfSymbol(id: string, cal: Calendar = getCalendar()): Market | undefined {
  const venue = id.slice(id.lastIndexOf(".") + 1)
  return MARKETS.find(m => cal.markets[m].venues.includes(venue))
}

export function defaultMarketOf(sourceId: string, sm: SourceMarkets = getSourceMarkets()): Market {
  for (const r of sm.rules) {
    if (r.prefix ? sourceId.startsWith(r.key) : sourceId === r.key) return r.market
  }
  return sm.default
}

/**
 * 一条新闻涉及的市场：标的的场所推出的市场（按 cn、us、crypto 的固定顺序，去重）；没有标的、或标的的场所都不认识时按来源的默认市场。
 */
export function marketsOf(symbols: string[], sourceId: string, cal: Calendar = getCalendar(), sm: SourceMarkets = getSourceMarkets()): Market[] {
  const found = new Set<Market>()
  for (const s of symbols) {
    const m = marketOfSymbol(s, cal)
    if (m) found.add(m)
  }
  return found.size ? MARKETS.filter(m => found.has(m)) : [defaultMarketOf(sourceId, sm)]
}

/** 一条新闻在它涉及的每个市场里的对齐结果。ts 用信息流的排序时间（feedTs）。 */
export function alignItem(ts: number, symbols: string[], sourceId: string, cal: Calendar = getCalendar(), sm: SourceMarkets = getSourceMarkets()): Align[] {
  return marketsOf(symbols, sourceId, cal, sm).map(m => alignAt(ts, m, cal))
}
