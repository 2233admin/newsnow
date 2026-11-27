/**
 * 用户源的配置：只存配置不存代码（#2185）。四种：
 * - rss：RSS / Atom 地址（复用 defineRSSSource）
 * - rsshub：RSSHub 路由（复用 defineRSSHubSource）
 * - json：标准 JSON API，地址 + 字段映射
 * - rule：声明式规则，CSS 选择器 + 字段映射（cheerio）
 *
 * 本文件只做形状校验与规范化，不出网、不碰库，Nitro 的自动导入也不依赖。
 */

export const USER_SOURCE_PREFIX = "user:"

export type UserSourceKind = "rss" | "rsshub" | "json" | "rule"
export const USER_SOURCE_KINDS: UserSourceKind[] = ["rss", "rsshub", "json", "rule"]

export interface RssSpec {
  kind: "rss"
  url: string
}

export interface RsshubSpec {
  kind: "rsshub"
  /** 以 / 开头的路由，可带查询串，如 /github/trending/daily；域名固定为内置的 RSSHub 实例 */
  route: string
  limit?: number
}

/**
 * 字段映射里的一项：点路径（`data.title`、`list.0.name`），
 * 或带 `{路径}` 占位的模板（`https://news.ycombinator.com/item?id={id}`）。
 */
export interface JsonSpec {
  kind: "json"
  url: string
  /** 条目数组所在的点路径；空串表示响应本身就是数组 */
  itemsPath: string
  /** 条目 id 去掉结尾的版本号（`v<数字>`）：同一篇稿子修订后 id 不变，不会重复入库（arXiv 的 `…/abs/2611.1v1` → `v2`） */
  idStripVersion?: true
  fields: {
    title: string
    url: string
    id?: string
    pubDate?: string
  }
}

/**
 * 声明式规则里的一项：`选择器@属性`。选择器相对条目元素；省略选择器（`@href`）取条目元素自己的属性；
 * 省略 `@属性` 取文本；`@html` 不支持。
 */
export interface RuleSpec {
  kind: "rule"
  url: string
  /** 每个匹配的元素是一条新闻 */
  item: string
  /** 同 JsonSpec.idStripVersion */
  idStripVersion?: true
  fields: {
    title: string
    url: string
    id?: string
    pubDate?: string
  }
}

export type UserSourceSpec = RssSpec | RsshubSpec | JsonSpec | RuleSpec

export interface UserSourceConfig {
  /** 不带命名空间的 slug；完整的源 id 是 `user:<slug>` */
  slug: string
  name: string
  category: string
  /** 刷新间隔，毫秒 */
  interval: number
  enabled: boolean
  spec: UserSourceSpec
}

export class InputError extends Error {
  /** retryAfterSec：限流类（429）错误建议多久后重试，HTTP 入口放进 Retry-After 头 */
  constructor(message: string, readonly status = 400, readonly retryAfterSec?: number) {
    super(message)
    this.name = "InputError"
  }
}

/**
 * 刷新间隔的上下限。
 * 下限 2 分钟：与内置源里最快的一档（shared/sources.ts 的 Time.Realtime）相同，tick 周期是 1 分钟，再快没有意义也不礼貌。
 * 上限 24 小时：每天至少抓一次，更慢的源应该直接停用。待定：没有实测依据，只是不让用户填出「永远不抓」的值。
 */
export const MIN_INTERVAL_MS = 2 * 60 * 1000
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_INTERVAL_MS = 10 * 60 * 1000

/**
 * 用户源总数上限。待定：采集并发 8、单源超时 60 秒（collector/config.ts），
 * 200 个源按最慢的 10 分钟档也只需每分钟约 20 个到期，在两核机器上不会堆积；超过需要先测。
 */
export const MAX_USER_SOURCES = 200

const MAX_NAME = 80
const MAX_CATEGORY = 32
const MAX_URL = 2048
const MAX_FIELD_EXPR = 200
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

export const toSourceId = (slug: string) => `${USER_SOURCE_PREFIX}${slug}`
export const isUserSourceId = (id: string) => id.startsWith(USER_SOURCE_PREFIX)
export const toSlug = (id: string) => id.slice(USER_SOURCE_PREFIX.length)

/** 与 /api/collector/sources/ 下的固定路径同名的 slug 会被路由抢走，保留 */
const RESERVED_SLUGS = new Set(["opml", "preview"])

export function assertSlug(slug: unknown): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new InputError("slug 只能含小写字母、数字和连字符，且以字母或数字开头，最长 48 个字符")
  if (RESERVED_SLUGS.has(slug)) throw new InputError(`slug ${slug} 是保留名`)
  return slug
}

/** 从名称（或地址）生成 slug；非 ASCII 的名称退回地址里的主机名，再退回 source。 */
export function slugify(...candidates: string[]): string {
  for (const c of candidates) {
    const s = c.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "")
    if (s) return s
  }
  return "source"
}

function str(value: unknown, label: string, max: number, opts: { optional?: boolean } = {}): string {
  if (value === undefined || value === null || value === "") {
    if (opts.optional) return ""
    throw new InputError(`${label} 不能为空`)
  }
  if (typeof value !== "string") throw new InputError(`${label} 必须是字符串`)
  // 换行与制表符折成空格：名称、分类、字段表达式里没有合法用途，留着只会破坏 OPML 属性
  const v = value.replace(/\s+/g, " ").trim()
  if (!v && !opts.optional) throw new InputError(`${label} 不能为空`)
  if (v.length > max) throw new InputError(`${label} 过长（最多 ${max} 个字符）`)
  return v
}

/** 地址的形状检查：只许 http/https、不带账号密码。是否指向内网由 net.ts 在出网时判断。 */
export function checkHttpUrl(value: unknown, label = "地址"): string {
  const raw = str(value, label, MAX_URL)
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new InputError(`${label} 不是合法的 URL`)
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new InputError(`${label} 只支持 http 或 https`)
  if (u.username || u.password) throw new InputError(`${label} 不能带账号密码`)
  return u.toString()
}

/** 约束 RSSHub 路由不能跳出内置的 RSSHub 域名（`//evil.com`、`http://…` 在 new URL(route, base) 里会覆盖 base）。 */
export function checkRsshubRoute(value: unknown, base: string): string {
  const route = str(value, "路由", 500)
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\") || /\s/.test(route) || [...route].some(c => c.charCodeAt(0) < 32))
    throw new InputError("RSSHub 路由必须以单个 / 开头，且不含空白与反斜杠，例如 /github/trending/daily")
  if (new URL(route, base).origin !== new URL(base).origin) throw new InputError("RSSHub 路由不能指向其他域名")
  return route
}

function fieldExpr(value: unknown, label: string, optional: boolean) {
  const v = str(value, label, MAX_FIELD_EXPR, { optional })
  return v || undefined
}

function fields(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new InputError("fields 必须是对象，至少包含 title 与 url")
  const f = raw as Record<string, unknown>
  const out: JsonSpec["fields"] = {
    title: fieldExpr(f.title, "fields.title", false)!,
    url: fieldExpr(f.url, "fields.url", false)!,
  }
  const id = fieldExpr(f.id, "fields.id", true)
  const pubDate = fieldExpr(f.pubDate, "fields.pubDate", true)
  if (id) out.id = id
  if (pubDate) out.pubDate = pubDate
  return out
}

function stripVersion(value: unknown): { idStripVersion?: true } {
  if (value === undefined || value === null || value === false) return {}
  if (value !== true) throw new InputError("idStripVersion 必须是布尔值")
  return { idStripVersion: true }
}

/** 校验并规范化一份 spec；多余的字段丢掉。 */
export function normalizeSpec(raw: unknown, rsshubBase: string): UserSourceSpec {
  if (!raw || typeof raw !== "object") throw new InputError("spec 必须是对象")
  const s = raw as Record<string, unknown>
  switch (s.kind) {
    case "rss":
      return { kind: "rss", url: checkHttpUrl(s.url) }
    case "rsshub": {
      const spec: RsshubSpec = { kind: "rsshub", route: checkRsshubRoute(s.route, rsshubBase) }
      if (s.limit !== undefined && s.limit !== null) {
        if (!Number.isInteger(s.limit) || (s.limit as number) < 1 || (s.limit as number) > 100) throw new InputError("limit 必须是 1 到 100 的整数")
        spec.limit = s.limit as number
      }
      return spec
    }
    case "json":
      return {
        kind: "json",
        url: checkHttpUrl(s.url),
        itemsPath: str(s.itemsPath, "itemsPath", MAX_FIELD_EXPR, { optional: true }),
        fields: fields(s.fields),
        ...stripVersion(s.idStripVersion),
      }
    case "rule":
      return {
        kind: "rule",
        url: checkHttpUrl(s.url),
        item: str(s.item, "item 选择器", MAX_FIELD_EXPR),
        fields: fields(s.fields),
        ...stripVersion(s.idStripVersion),
      }
    default:
      throw new InputError(`spec.kind 必须是 ${USER_SOURCE_KINDS.join(" / ")} 之一`)
  }
}

export function normalizeInterval(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_INTERVAL_MS
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS)
    throw new InputError(`interval 必须是 ${MIN_INTERVAL_MS} 到 ${MAX_INTERVAL_MS} 之间的整数（毫秒）`)
  return value
}

export function normalizeName(value: unknown) {
  return str(value, "名称", MAX_NAME)
}

export function normalizeCategory(value: unknown) {
  return str(value, "分类", MAX_CATEGORY, { optional: true })
}

export function normalizeEnabled(value: unknown, fallback = true) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "boolean") throw new InputError("enabled 必须是布尔值")
  return value
}

/** 用户源的主要地址（用于去重与展示） */
export function specAddress(spec: UserSourceSpec) {
  return spec.kind === "rsshub" ? spec.route : spec.url
}
