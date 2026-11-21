import { encodeCursor, normalizeFeedParams } from "./params"
import type { FeedParams } from "./params"
import type { FeedStore } from "./store"
import type { SourceDescriptor } from "#/registry/registry"
import type { IngestedItem } from "#/collector/store"
import type { GroupInfo, GroupMember } from "#/enrich/store"

/** 一组里除主条目外的成员（同一事件的其他报道）。 */
export interface FeedMemberView {
  seq: number
  sourceId: string
  sourceName: string
  itemId: string
  url: string | null
  origUrl: string | null
  pubDate: number | null
  firstSeenAt: number
}

/** 信息流里一条新闻的对外形状（GET /api/feed 与 SSE 共用）。 */
export interface FeedItemView {
  /** 入库顺序号，单调递增；SSE 的 id 就是它 */
  seq: number
  sourceId: string
  /** 源的显示名与分类，库里没有说明的源（已删除）退回 id 与空串 */
  sourceName: string
  category: string
  itemId: string
  /** 原始标题（原样入库，不改） */
  title: string
  /** 清洗后的标题：解码了 HTML 实体、去掉了 Google News 的「 - 来源」后缀；还没富化的等于 title */
  cleanTitle: string
  url: string | null
  /** 解出的原文链接（目前只有 Google News 旧格式链接解得出；新格式解不出，是 null，前端用 url） */
  origUrl: string | null
  /** 识别出的标的（品种 id「代码.场所」），没有是空数组 */
  symbols: string[]
  /** 所在组的主条目 seq；自己是主条目或没有重复的就是自己的 seq */
  groupId: number
  /** 不为 null 时这条是 groupId 那一组的成员（成员行只在 expand=1 时出现） */
  dupOf: number | null
  /** 这一组的来源数（不同 source_id 的个数，含主条目），没有重复的是 1 */
  sourcesCount: number
  /** 主条目带上除自己外的成员（至多 50 个，按入库先后）；成员行没有 */
  members: FeedMemberView[]
  /** 源站给的发布时间，没有是 null */
  pubDate: number | null
  /** 第一次被采集到的时间 */
  firstSeenAt: number
  /** 排序时间：有发布时间用发布时间，没有用 firstSeenAt（晚于 firstSeenAt 的发布时间按 firstSeenAt 算） */
  feedTs: number
}

export interface FeedResponse {
  items: FeedItemView[]
  /** 下一页的游标；null = 到底了 */
  nextCursor: string | null
  /**
   * 本次查询开始时的最大 seq。首屏之后用它做 SSE 的 Last-Event-ID，
   * 首屏读取与订阅之间入库的条目会被补发（可能与首屏重复，按 seq 或 (sourceId, itemId) 去重）。
   */
  latestSeq: number
  now: number
}

export interface FeedServiceDeps {
  store: FeedStore
  describe: () => Promise<SourceDescriptor[]>
  clock?: () => number
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase())

function sourceMatcher(patterns: string[]) {
  const exact = new Set(patterns.filter(p => !p.endsWith("*")))
  const prefixes = patterns.filter(p => p.endsWith("*")).map(p => p.slice(0, -1))
  return (id: string) => exact.has(id) || prefixes.some(p => id.startsWith(p))
}

/**
 * 把「来源 / 分类 / 是否含停用」解析成具体的源 id 集合；null = 不限（不用 json_each）。
 * 分类在库里没有存（用户随时能改），所以每次从注册表现算。
 */
export function resolveScope(params: Pick<FeedParams, "source" | "category" | "includeInactive">, descs: SourceDescriptor[]): string[] | null {
  const { source, category, includeInactive } = params
  if (!source.length && !category.length && includeInactive) return null
  let pool = descs.filter(d => includeInactive || d.enabled)
  if (category.length) {
    const cats = new Set(category.map(asciiLower))
    pool = pool.filter(d => cats.has(asciiLower(d.category)))
  }
  const ids = new Set<string>()
  if (source.length) {
    const match = sourceMatcher(source)
    for (const d of pool) {
      if (match(d.id)) ids.add(d.id)
    }
    // 已删除的源在注册表里没有说明，但用户明确点名并带 includeInactive 时，它的历史条目仍然查得到
    if (includeInactive && !category.length) {
      for (const s of source) {
        if (!s.endsWith("*")) ids.add(s)
      }
    }
    return [...ids]
  }
  return pool.map(d => d.id)
}

/**
 * 对外只给 http / https 链接：内置源的适配器不经 sanitizeItems（用户源的才经过），
 * 条目里的 url 可能是 javascript:、data: 之类，前端若直接当 href 渲染就是 XSS。这里在服务端再过一道（#2264 第 6 项的服务端一半），
 * 前端渲染时仍应再挡一次。不是合法 URL 或协议不对的置 null。
 */
export function safeUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw.trim())
    return u.protocol === "http:" || u.protocol === "https:" ? raw.trim() : null
  } catch {
    return null
  }
}

function memberView(m: GroupMember, byId: Map<string, SourceDescriptor>): FeedMemberView {
  return {
    seq: m.seq,
    sourceId: m.sourceId,
    sourceName: byId.get(m.sourceId)?.name ?? m.sourceId,
    itemId: m.itemId,
    url: safeUrl(m.url),
    origUrl: safeUrl(m.origUrl),
    pubDate: m.pubDate,
    firstSeenAt: m.firstSeenAt,
  }
}

export function toView(item: IngestedItem, byId: Map<string, SourceDescriptor>, group?: GroupInfo, expand = false): FeedItemView {
  const d = byId.get(item.sourceId)
  return {
    seq: item.seq,
    sourceId: item.sourceId,
    sourceName: d?.name ?? item.sourceId,
    category: d?.category ?? "",
    itemId: item.itemId,
    title: item.title,
    cleanTitle: item.cleanTitle ?? item.title,
    url: safeUrl(item.url),
    origUrl: safeUrl(item.origUrl),
    symbols: item.symbols,
    groupId: item.dupOf ?? item.seq,
    dupOf: item.dupOf,
    sourcesCount: group?.sourcesCount ?? 1,
    // 代表行是主条目：列出其余成员；代表行是成员（按来源范围收拢时）：列出组里的其余条目，主条目在最前
    members: group && !(expand && item.dupOf !== null) ? (item.dupOf === null ? group.members : [group.main, ...group.members].filter(m => m.seq !== item.seq)).map(m => memberView(m, byId)) : [],
    pubDate: item.pubDate,
    firstSeenAt: item.firstSeenAt,
    feedTs: item.feedTs,
  }
}

/**
 * SSE 用：一条条目是否符合订阅的筛选（来源、分类、关键词、标的；时间类参数对实时流没有意义）。
 * 标的：expand=1 按条目自己带的算；默认（每组一行）由实时流另查组（FeedStore.groupHasSymbol），与查询接口一致。
 */
export function streamMatcher(params: FeedParams, descs: SourceDescriptor[]) {
  const scope = resolveScope(params, descs)
  const allowed = scope ? new Set(scope) : undefined
  const keywords = params.keywords.map(asciiLower)
  const symbols = new Set(params.symbol)
  return (item: IngestedItem) =>
    (!allowed || allowed.has(item.sourceId))
    && keywords.every(k => asciiLower(item.title).includes(k) || asciiLower(item.cleanTitle ?? "").includes(k))
    && (!symbols.size || item.symbols.some(s => symbols.has(s)))
}

export function createFeedService(deps: FeedServiceDeps) {
  const { store, describe } = deps
  const clock = deps.clock ?? Date.now

  return {
    async query(raw: Record<string, unknown>): Promise<FeedResponse> {
      const params = normalizeFeedParams(raw)
      // 先读 latestSeq 再读页：读页之后入库的条目 seq 一定更大，会被 SSE 补发
      const latestSeq = await store.latestSeq()
      const now = clock()
      const descs = await describe()
      const sourceIds = resolveScope(params, descs)
      const { rows, hasMore, groups } = await store.page(
        { sourceIds, from: params.from, to: params.to, since: params.since, keywords: params.keywords, symbols: params.symbol, expand: params.expand },
        params.limit,
        params.cursor,
      )
      const byId = new Map(descs.map(d => [d.id, d]))
      const last = rows.at(-1)
      return {
        items: rows.map(r => toView(r, byId, groups.get(r.dupOf ?? r.seq), params.expand)),
        nextCursor: hasMore && last ? encodeCursor({ feedTs: last.feedTs, sourceId: last.sourceId, itemId: last.itemId }) : null,
        latestSeq,
        now,
      }
    },
  }
}

export type FeedService = ReturnType<typeof createFeedService>
