import * as cheerio from "cheerio"
import type { NewsItem } from "@shared/types"
import { buildGetter } from "./adapters"
import type { FetchText } from "./adapters"
import { InputError, checkHttpUrl, checkRsshubRoute } from "./spec"
import type { JsonSpec, UserSourceSpec } from "./spec"

/** 预览条数（#2185 要求「抓 5 条预览」） */
export const PREVIEW_ITEMS = 5

export interface Preview {
  spec: UserSourceSpec
  /** 建议的名称：feed 的标题、页面标题，或主机名 */
  name: string
  items: NewsItem[]
  /** 本次解析出的总条数（预览只给前几条） */
  total: number
  /** 自动识别时的说明，如「从网页里发现了 RSS 地址」 */
  note?: string
}

const FEED_HEAD = /<(?:rss|feed|rdf:RDF)[\s>]/i
const TITLE_KEYS = ["title", "headline", "name", "text", "summary", "content"]
const URL_KEYS = ["url", "link", "href", "permalink", "web_url", "share_url", "uri"]
const ID_KEYS = ["id", "guid", "uuid", "objectid"]
const DATE_KEYS = ["pubdate", "published", "published_at", "publishedat", "pub_date", "date", "created_at", "createdat", "created", "time", "timestamp", "updated_at"]
const LIST_KEYS = ["data", "items", "list", "results", "articles", "news", "entries", "posts", "result"]

function isObjectList(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.length > 0 && v.every(x => x !== null && typeof x === "object" && !Array.isArray(x))
}

/** 找条目数组：响应本身，或前两层里第一个对象数组（常见的键名优先）。 */
function findList(body: unknown): { path: string, list: Record<string, unknown>[] } | undefined {
  if (isObjectList(body)) return { path: "", list: body }
  if (body === null || typeof body !== "object") return undefined
  const rank = (k: string) => {
    const i = LIST_KEYS.indexOf(k.toLowerCase())
    return i === -1 ? LIST_KEYS.length : i
  }
  const keys = (o: object) => Object.keys(o).sort((a, b) => rank(a) - rank(b))
  for (const k of keys(body)) {
    const v = (body as any)[k]
    if (isObjectList(v)) return { path: k, list: v }
  }
  for (const k of keys(body)) {
    const v = (body as any)[k]
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue
    for (const k2 of keys(v)) {
      if (isObjectList((v as any)[k2])) return { path: `${k}.${k2}`, list: (v as any)[k2] }
    }
  }
}

function pickKey(sample: Record<string, unknown>, candidates: string[], accept: (v: unknown) => boolean) {
  const byLower = new Map(Object.keys(sample).map(k => [k.toLowerCase(), k]))
  for (const c of candidates) {
    const k = byLower.get(c)
    if (k !== undefined && accept(sample[k])) return k
  }
}

const isText = (v: unknown) => typeof v === "string" && v.trim().length > 0
const isScalarId = (v: unknown) => isText(v) || typeof v === "number"

/** 从响应猜 JSON 源的映射；猜不出标题或链接就抛错，让用户手动给。 */
export function guessJsonSpec(url: string, body: unknown): JsonSpec {
  const found = findList(body)
  if (!found) throw new InputError("JSON 里找不到条目数组，请手动给 itemsPath 与 fields", 422)
  const sample = found.list[0]
  const title = pickKey(sample, TITLE_KEYS, isText)
  const link = pickKey(sample, URL_KEYS, isText)
  if (!title || !link) throw new InputError(`在 ${found.path || "根"} 的条目里猜不出 ${!title ? "标题" : "链接"} 字段，请手动给 fields`, 422)
  const spec: JsonSpec = { kind: "json", url, itemsPath: found.path, fields: { title, url: link } }
  const id = pickKey(sample, ID_KEYS, isScalarId)
  const date = pickKey(sample, DATE_KEYS, v => isScalarId(v))
  if (id) spec.fields.id = id
  if (date) spec.fields.pubDate = date
  return spec
}

/** 网页里 <link rel="alternate" type="application/rss+xml|atom+xml" href> 的第一个。 */
export function discoverFeedUrl(html: string, pageUrl: string): string | undefined {
  const $ = cheerio.load(html)
  const href = $("link[rel~=alternate]").filter((_, el) => /(?:rss|atom)\+xml/i.test($(el).attr("type") ?? "")).first().attr("href")
  if (!href) return undefined
  try {
    return new URL(href, pageUrl).toString()
  } catch {
    return undefined
  }
}

function pageTitle(html: string) {
  return cheerio.load(html)("title").first().text().replace(/\s+/g, " ").trim()
}

/** 跑一遍适配器，取前 PREVIEW_ITEMS 条；解析不出条目就报错，不让用户保存一个空源。 */
export async function runPreview(spec: UserSourceSpec, fetchText: FetchText, name: string, note?: string): Promise<Preview> {
  let items: NewsItem[]
  try {
    items = await buildGetter(spec, fetchText)()
  } catch (e) {
    if (e instanceof InputError) throw e
    throw new InputError(`抓取或解析失败：${e instanceof Error ? e.message : String(e)}`, 422)
  }
  items = items.filter(i => i?.title && String(i.title).trim())
  if (!items.length) throw new InputError("没有解析出任何条目，请检查地址或映射", 422)
  return { spec, name, items: items.slice(0, PREVIEW_ITEMS), total: items.length, note }
}

function feedTitle(xml: string) {
  return cheerio.load(xml, { xml: true })("channel > title, feed > title").first().text().trim()
}

export interface DetectDeps {
  fetchText: FetchText
  rsshubBase: string
}

/**
 * 给一个地址，自动识别类型并预览：
 * 1. `/路由` 或 `rsshub://路由` → RSSHub；
 * 2. 响应像 RSS / Atom → rss；
 * 3. 响应是 JSON → 猜条目数组与字段映射 → json；
 * 4. 响应是网页：先找页面里声明的 RSS，找到就按 rss；找不到说明要手写选择器（rule），不猜。
 */
export async function detect(input: string, deps: DetectDeps): Promise<Preview> {
  const raw = input.trim()
  if (raw.startsWith("/") || raw.startsWith("rsshub://")) {
    const route = checkRsshubRoute(raw.startsWith("rsshub://") ? `/${raw.slice("rsshub://".length)}` : raw, deps.rsshubBase)
    return await runPreview({ kind: "rsshub", route }, deps.fetchText, route, "按 RSSHub 路由识别")
  }
  const url = checkHttpUrl(raw)
  const text = await deps.fetchText(url)
  // 已抓到的响应不再抓第二遍
  const cached: FetchText = u => (u === url ? Promise.resolve(text) : deps.fetchText(u))
  const head = text.trimStart().slice(0, 2048)

  if (FEED_HEAD.test(head)) return await runPreview({ kind: "rss", url }, cached, feedTitle(text) || new URL(url).hostname, "按 RSS / Atom 识别")

  if (head.startsWith("{") || head.startsWith("[")) {
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new InputError("响应看起来是 JSON 但解析失败", 422)
    }
    const spec = guessJsonSpec(url, body)
    return await runPreview(spec, cached, new URL(url).hostname, `按 JSON 识别：条目在 ${spec.itemsPath || "根"}，字段 ${JSON.stringify(spec.fields)}`)
  }

  const feed = discoverFeedUrl(text, url)
  if (feed) {
    checkHttpUrl(feed)
    const feedText = await deps.fetchText(feed)
    if (!FEED_HEAD.test(feedText.trimStart().slice(0, 2048))) throw new InputError(`网页声明的 RSS 地址 ${feed} 返回的不是 RSS`, 422)
    return await runPreview({ kind: "rss", url: feed }, u => (u === feed ? Promise.resolve(feedText) : deps.fetchText(u)), feedTitle(feedText) || pageTitle(text) || new URL(url).hostname, `网页里声明了 RSS：${feed}`)
  }
  throw new InputError("这是网页，没有声明 RSS，也不是 JSON：需要手写选择器（spec.kind 为 rule），或改用站点的 RSS / RSSHub 地址", 422)
}
