import * as cheerio from "cheerio"
import type { NewsItem } from "@shared/types"
import type { JsonSpec, RuleSpec, UserSourceSpec } from "./spec"
import type { SourceGetter } from "#/types"
import { RSSHUB_BASE, defineRSSHubSource, defineRSSSource } from "#/utils/source"

/** 用户源适配器的出网函数：带 SSRF 防护的文本抓取（net.ts 的 safeFetchText 已绑定策略） */
export type FetchText = (url: string) => Promise<string>

/** 点路径取值：`a.b.0.c`；中间任何一层不是对象或数组就返回 undefined。不支持表达式，所以配置里不会有可执行的东西。 */
export function getPath(value: unknown, path: string): unknown {
  if (!path) return value
  let cur: any = value
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined
    // 只读自有属性，挡住 __proto__ / constructor
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined
    cur = cur[key]
  }
  return cur
}

const scalar = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "")

/** 字段表达式：含 `{路径}` 的当模板，否则当点路径。 */
function evalField(item: unknown, expr: string | undefined): string {
  if (!expr) return ""
  if (expr.includes("{")) return expr.replace(/\{([^{}]+)\}/g, (_, p: string) => scalar(getPath(item, p.trim())))
  return scalar(getPath(item, expr))
}

/** 数字 < 1e11 当秒（1e11 秒是公元 5138 年，1e11 毫秒是 1973 年），否则当毫秒；字符串原样交给 store 的 toTimestamp。 */
export function normalizeDate(raw: string): number | string | undefined {
  if (!raw) return undefined
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw)
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
  }
  return raw
}

function absolute(href: string, base: string) {
  if (!href) return ""
  try {
    return new URL(href, base).toString()
  } catch {
    return ""
  }
}

function finish(partial: { title: string, url: string, id: string, date: string }, base: string): NewsItem | undefined {
  const url = absolute(partial.url, base)
  if (!partial.title) return undefined
  return {
    id: partial.id || url || partial.title,
    title: partial.title,
    url,
    pubDate: normalizeDate(partial.date),
  }
}

export function mapJson(body: unknown, spec: JsonSpec): NewsItem[] {
  const list = getPath(body, spec.itemsPath)
  if (!Array.isArray(list)) throw new Error(`itemsPath "${spec.itemsPath}" 没有指向数组`)
  const items: NewsItem[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue
    const item = finish({
      title: evalField(raw, spec.fields.title),
      url: evalField(raw, spec.fields.url),
      id: evalField(raw, spec.fields.id),
      date: evalField(raw, spec.fields.pubDate),
    }, spec.url)
    if (item) items.push(item)
  }
  return items
}

/** `选择器@属性` 拆开；选择器里的 @ 极少见，取最后一个 @ 之后当属性（属性名只含字母数字与连字符）。 */
export function parseRuleExpr(expr: string): { selector: string, attr?: string } {
  const m = /^(.*)@([\w-]+)$/.exec(expr)
  return m ? { selector: m[1].trim(), attr: m[2] } : { selector: expr.trim() }
}

function evalRule($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0], expr: string | undefined): string {
  if (!expr) return ""
  const { selector, attr } = parseRuleExpr(expr)
  const root = $(el)
  const target = selector ? root.find(selector).first() : root
  if (!target.length) return ""
  return (attr ? target.attr(attr) ?? "" : target.text()).replace(/\s+/g, " ").trim()
}

export function mapRule(html: string, spec: RuleSpec): NewsItem[] {
  const $ = cheerio.load(html)
  const items: NewsItem[] = []
  $(spec.item).each((_, el) => {
    const item = finish({
      title: evalRule($, el, spec.fields.title),
      url: evalRule($, el, spec.fields.url),
      id: evalRule($, el, spec.fields.id),
      date: evalRule($, el, spec.fields.pubDate),
    }, spec.url)
    if (item) items.push(item)
  })
  return items
}

/**
 * 用户源出口的统一过滤（四种 kind 都经过）：条目链接只留 http / https，相对链接按 base 补全；
 * 其余 scheme（javascript:、data:、file:、vbscript:、blob: …）或没有链接的条目**整条丢弃**，而不是只清空 url：
 * rss 与 json / rule 都会拿链接兜底当 id，只清 url 会让坏链接以 id 的形式进库。
 * 内容由第三方站点控制，而新闻面板会把 url 渲染成可点的链接。KATANAview 渲染端另有一道（跟进票）。
 */
export function sanitizeItems(items: NewsItem[], base: string): NewsItem[] {
  const out: NewsItem[] = []
  for (const item of items) {
    const raw = typeof item?.url === "string" ? item.url : ""
    if (!raw.trim()) continue
    let parsed: URL
    try {
      parsed = new URL(raw, base)
    } catch {
      continue
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue
    const url = parsed.toString()
    out.push({ ...item, url, id: item.id === raw ? url : item.id })
  }
  return out
}

/** 配置 → 适配器。四种都复用现有的适配器形状（() => Promise<NewsItem[]>），输出统一过 sanitizeItems。 */
export function buildGetter(spec: UserSourceSpec, fetchText: FetchText): SourceGetter {
  const raw = buildRawGetter(spec, fetchText)
  const base = spec.kind === "rsshub" ? RSSHUB_BASE : spec.url
  return async () => sanitizeItems(await raw(), base)
}

function buildRawGetter(spec: UserSourceSpec, fetchText: FetchText): SourceGetter {
  switch (spec.kind) {
    case "rss":
      return defineRSSSource(spec.url, { fetchText })
    case "rsshub":
      return defineRSSHubSource(spec.route, spec.limit ? { limit: spec.limit } : undefined, { fetchText })
    case "json":
      return async () => {
        const text = await fetchText(spec.url)
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          throw new Error("响应不是合法的 JSON")
        }
        return mapJson(body, spec)
      }
    case "rule":
      return async () => mapRule(await fetchText(spec.url), spec)
  }
}
