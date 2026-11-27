import { encodeCursor, normalizeFeedParams } from "./params"
import type { FeedParams } from "./params"
import type { DayBucket, FeedFilter, FeedStore } from "./store"
import { InputError } from "#/registry/spec"
import type { SourceDescriptor } from "#/registry/registry"
import type { IngestedItem } from "#/collector/store"
import type { GroupInfo, GroupMember } from "#/enrich/store"
import type { Align, FilterReason, ItemTags, Market } from "#/enrich/types"
import { DIRECTIONS, MARKETS, SESSIONS } from "#/enrich/types"
import { MARKET_LABELS } from "#/enrich/align"
import { FILTER_REASON_LABELS } from "#/enrich/filter"
import { getImpactConfig } from "#/enrich/impact"
import { DeepNotFound } from "#/enrich/deep"
import type { DeepReader, DeepResponse } from "#/enrich/deep"

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
  /**
   * 对齐交易日：这条新闻涉及的每个市场一项（标的的场所推出市场，没有标的按来源的默认市场；顺序固定 cn、us、crypto），
   * 按这条自己的 feedTs 算。收盘后与休市日的新闻 tradeDate 是下一个交易日。还没富化的条目是空数组。
   */
  align: Align[]
  /**
   * 分类标注（影响类型、方向、一句话要点、题材），挂在组上：主条目与成员行拿到的是同一份（组的标注持有者的：组里 seq 最小、没被规则层过滤的成员，通常是主条目）。themes 是 string[] 或 null（null = 模型没给题材字段）。
   * null = 还没标：没配模型、还在排队、被规则层过滤、或这一组标注失败到了上限。方向（positive 正面 / negative 负面 / neutral 中性）只是对这条新闻本身的读法，不是涨跌预测。
   */
  tags: ItemTags | null
  /** 规则层的过滤原因（advert 广告 / stock_tout 荐股软文 / ranking_list 榜单水文 / market_roundup 行情罗列）；没被过滤是 null，默认查询里只会见到 null，includeFiltered=1 才见到非 null */
  filterReason: FilterReason | null
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

export interface DaysResponse {
  /** 用的市场（给了 market 就是它，否则由 symbol 的场所推出） */
  market: Market
  tradeDateFrom: string
  tradeDateTo: string
  /** 区间内有新闻的交易日，升序；没有新闻的日子不出 */
  days: DayBucket[]
  now: number
}

/** 日聚合的区间上限（自然日）。待定：约三年的交易日（每年约 250 个）；按 idx_item_align_date 扫一段区间，没有按大库实测定。 */
export const MAX_DAYS_SPAN = 800

export interface FeedServiceDeps {
  store: FeedStore
  describe: () => Promise<SourceDescriptor[]>
  clock?: () => number
  /** 按需深读（没给 = 这个部署不提供） */
  deep?: DeepReader
  /** 模型配了没有：批量标注、深读各一项（给 meta 用） */
  capabilities?: { tagging: boolean, deep: boolean }
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
    align: item.align,
    // 标注挂在主条目上：组读出来的优先（成员行也能拿到），没有组信息的退回条目自己的
    tags: group ? group.tags : item.tags,
    filterReason: item.filterReason,
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
  // 实时流在条目入库的那一刻推：标注（异步补的）与对齐过滤（时间类参数）此时没有意义；规则层的过滤是入库时就定的，照默认隐藏
  return (item: IngestedItem) =>
    (params.includeFiltered || !item.filterReason)
    && (!allowed || allowed.has(item.sourceId))
    && keywords.every(k => asciiLower(item.title).includes(k) || asciiLower(item.cleanTitle ?? "").includes(k))
    && (!symbols.size || item.symbols.some(s => symbols.has(s)))
}

/** 查询参数 → 存储层的过滤条件（page 与 days 共用，口径不能分叉）。 */
function filterOf(params: FeedParams, sourceIds: string[] | null): FeedFilter {
  return {
    sourceIds,
    from: params.from,
    to: params.to,
    since: params.since,
    keywords: params.keywords,
    symbols: params.symbol,
    expand: params.expand,
    includeFiltered: params.includeFiltered,
    market: params.market,
    tradeDate: params.tradeDate,
    tradeDateFrom: params.tradeDateFrom,
    tradeDateTo: params.tradeDateTo,
    impact: params.impact,
    direction: params.direction,
    themes: params.theme,
  }
}

const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000

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
      const { rows, hasMore, groups } = await store.page(filterOf(params, sourceIds), params.limit, params.cursor)
      const byId = new Map(descs.map(d => [d.id, d]))
      const last = rows.at(-1)
      return {
        items: rows.map(r => toView(r, byId, groups.get(r.dupOf ?? r.seq), params.expand)),
        nextCursor: hasMore && last ? encodeCursor({ feedTs: last.feedTs, sourceId: last.sourceId, itemId: last.itemId }) : null,
        latestSeq,
        now,
      }
    },

    /**
     * 按交易日聚合（GET /api/feed/days）：市场（或由 symbol 推出）+ 交易日区间 → 每个有新闻的交易日的条数、按影响类型与方向的分布。
     * 其余筛选（symbol、source、category、q、impact、direction、includeFiltered、expand……）与 query 同一套，所以某一天的 count 等于
     * query 带同样参数与 tradeDate = 这一天的总条数。limit / cursor / since 对它没有意义，不看。
     */
    async days(raw: Record<string, unknown>): Promise<DaysResponse> {
      const params = normalizeFeedParams(raw)
      const market = params.market
      if (!market) throw new InputError("需要 market（cn / us / crypto），或给 symbol 由它的场所推出市场：交易日是各市场自己的")
      const from = params.tradeDateFrom ?? params.tradeDate
      const to = params.tradeDateTo ?? params.tradeDate
      if (!from || !to) throw new InputError("需要交易日区间：tradeDateFrom 与 tradeDateTo 都要给（或只给 tradeDate 表示一天）")
      if (dayNumber(to) - dayNumber(from) + 1 > MAX_DAYS_SPAN) throw new InputError(`交易日区间最长 ${MAX_DAYS_SPAN} 天`)
      const descs = await describe()
      const filter = filterOf({ ...params, since: undefined }, resolveScope(params, descs))
      const days = await store.days({ ...filter, market, tradeDateFrom: from, tradeDateTo: to, tradeDate: undefined })
      return { market, tradeDateFrom: from, tradeDateTo: to, days, now: clock() }
    },

    /**
     * 按需深读一条（按 seq）：第一次调模型，结果缓存进库，之后直接读缓存。没配模型返回 status = unavailable（不是错误）；
     * 模型出错 status = error（不缓存，可重试）；seq 不存在抛 404。
     */
    async deep(rawSeq: unknown): Promise<DeepResponse> {
      const seq = typeof rawSeq === "number" ? rawSeq : typeof rawSeq === "string" && /^\d{1,15}$/.test(rawSeq.trim()) ? Number(rawSeq.trim()) : Number.NaN
      if (!Number.isSafeInteger(seq) || seq < 1) throw new InputError("seq 必须是正整数（新闻的 seq）")
      if (!deps.deep) return { seq, status: "unavailable", cached: false, deep: null, basis: null, model: null, createdAt: null, message: "这个部署没有开启深读" }
      try {
        return await deps.deep.read(seq)
      } catch (e) {
        if (e instanceof DeepNotFound) throw new InputError(e.message, 404)
        throw e
      }
    },

    /** 筛选与展示要用的枚举：影响类型分类表（按市场）、方向、时段、过滤原因，以及模型有没有配。 */
    meta() {
      const impact = getImpactConfig()
      return {
        markets: MARKETS.map(id => ({ id, label: MARKET_LABELS[id], impactTypes: impact[id].types })),
        directions: DIRECTIONS,
        sessions: SESSIONS,
        filterReasons: Object.entries(FILTER_REASON_LABELS).map(([id, label]) => ({ id, label })),
        tagging: { configured: deps.capabilities?.tagging ?? false },
        deep: { configured: deps.capabilities?.deep ?? false },
      }
    },
  }
}

export type FeedService = ReturnType<typeof createFeedService>
