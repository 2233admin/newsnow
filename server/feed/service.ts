import { encodeCursor, normalizeFeedParams } from "./params"
import type { FeedParams } from "./params"
import type { FeedStore } from "./store"
import type { SourceDescriptor } from "#/registry/registry"
import type { IngestedItem } from "#/collector/store"

/** 信息流里一条新闻的对外形状（GET /api/feed 与 SSE 共用）。 */
export interface FeedItemView {
  /** 入库顺序号，单调递增；SSE 的 id 就是它 */
  seq: number
  sourceId: string
  /** 源的显示名与分类，库里没有说明的源（已删除）退回 id 与空串 */
  sourceName: string
  category: string
  itemId: string
  title: string
  url: string | null
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
  /** 收到了但还没有实现的筛选（目前只有 symbol，等 #2188 富化）；出现时结果按「没有匹配」返回 */
  unimplemented?: string[]
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

export function toView(item: IngestedItem, byId: Map<string, SourceDescriptor>): FeedItemView {
  const d = byId.get(item.sourceId)
  return {
    seq: item.seq,
    sourceId: item.sourceId,
    sourceName: d?.name ?? item.sourceId,
    category: d?.category ?? "",
    itemId: item.itemId,
    title: item.title,
    url: item.url,
    pubDate: item.pubDate,
    firstSeenAt: item.firstSeenAt,
    feedTs: item.feedTs,
  }
}

/** SSE 用：一条条目是否符合订阅的筛选（来源、分类、关键词；时间类参数对实时流没有意义）。 */
export function streamMatcher(params: FeedParams, descs: SourceDescriptor[]) {
  const scope = resolveScope(params, descs)
  const allowed = scope ? new Set(scope) : undefined
  const keywords = params.keywords.map(asciiLower)
  return (item: IngestedItem) =>
    (!allowed || allowed.has(item.sourceId)) && keywords.every(k => asciiLower(item.title).includes(k))
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
      if (params.symbol.length) return { items: [], nextCursor: null, latestSeq, now, unimplemented: ["symbol"] }
      const descs = await describe()
      const sourceIds = resolveScope(params, descs)
      const { rows, hasMore } = await store.page(
        { sourceIds, from: params.from, to: params.to, since: params.since, keywords: params.keywords },
        params.limit,
        params.cursor,
      )
      const byId = new Map(descs.map(d => [d.id, d]))
      const last = rows.at(-1)
      return {
        items: rows.map(r => toView(r, byId)),
        nextCursor: hasMore && last ? encodeCursor({ feedTs: last.feedTs, sourceId: last.sourceId, itemId: last.itemId }) : null,
        latestSeq,
        now,
      }
    },
  }
}

export type FeedService = ReturnType<typeof createFeedService>
