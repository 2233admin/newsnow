import type { Database, Primitive } from "db0"
import { ITEM_SELECT, itemFromRow } from "#/collector/store"
import type { IngestedItem } from "#/collector/store"
import { EnrichStore } from "#/enrich/store"
import type { GroupInfo } from "#/enrich/store"
import type { Direction, Market } from "#/enrich/types"

/**
 * 信息流的读取（#2186）。只读 items 表，写在 collector/store.ts。
 *
 * 排序键：(feed_ts, source_id, item_id) 三列倒序，三列合起来唯一（后两列是 items 的唯一键），所以同一毫秒有多条也有确定的先后。
 * feed_ts 与 seq 的定义见 collector/store.ts 文件头。游标就是上一页最后一条的这三个值，用行值比较
 * `(feed_ts, source_id, item_id) < (?, ?, ?)` 走 idx_items_feed，不是 OFFSET：翻页期间有新条目入库，已翻过的位置不会漂。
 *
 * SQL 一律参数化。来源集合用一个参数传 JSON 数组再 json_each 展开（SQLite 与 D1 都有 JSON1）：用户源最多 200 个，
 * 逐个占位符会超过 D1 单条语句 100 个绑定参数的上限；这样一条语句的参数个数固定在 20 以内。
 */

export interface FeedCursor {
  feedTs: number
  sourceId: string
  itemId: string
}

export interface FeedFilter {
  /** 限定在这些源里；null 不限。空数组 = 什么也匹配不上。 */
  sourceIds: string[] | null
  /** feed_ts ≥ from */
  from?: number
  /** feed_ts < to */
  to?: number
  /** first_seen_at ≥ since（入库时间，含端点：同一毫秒里后到的条目不会被漏掉，客户端按 seq 去重） */
  since?: number
  /** 标题（原始标题或清洗后的标题）须包含每一个词（AND，不分大小写仅对 ASCII 生效：SQLite LIKE 的限制） */
  keywords: string[]
  /**
   * 标的（品种 id）：条目自己带其中任一个，或（默认按组时）它所在组的任一成员带，就算命中。空数组 = 不按标的限。
   */
  symbols: string[]
  /** true：每条都单独出现（成员也算）；false：每组只出主条目一行（dup_of 为空的） */
  expand: boolean
  /** 含规则层过滤掉的条目；默认（不给）不含。被过滤的条目在按组收拢时当作「不在范围里」，同来源范围一个道理 */
  includeFiltered?: boolean
  /** 按这个市场对齐过交易日的条目（与 tradeDate 一起用时限定在这个市场的这一天） */
  market?: Market
  /** 条目在某个市场里对齐到这个交易日（YYYY-MM-DD） */
  tradeDate?: string
  /** 组的影响类型命中其中之一（标注挂在主条目上，按组判断，同标的）。空 / 不给 = 不限 */
  impact?: string[]
  /** 组的方向命中其中之一 */
  direction?: Direction[]
}

export interface FeedPage {
  rows: IngestedItem[]
  /** 还有更早的条目；nextCursor 由最后一条算出 */
  hasMore: boolean
  /** 本页各条所在的组（主条目 seq → 成员与来源数） */
  groups: Map<number, GroupInfo>
}

function rowsOf<T>(res: unknown): T[] {
  const rows = (res as { results?: unknown })?.results ?? res
  return Array.isArray(rows) ? rows as T[] : []
}

const escapeLike = (term: string) => term.replace(/[\\%_]/g, c => `\\${c}`)

/** 范围条件（时间、游标）：这些能直接用 idx_items_feed 定位。 */
function rangeWhere(filter: FeedFilter, cursor?: FeedCursor) {
  const where: string[] = []
  const params: Primitive[] = []
  if (filter.from !== undefined) {
    where.push(`feed_ts >= ?`)
    params.push(filter.from)
  }
  if (filter.to !== undefined) {
    where.push(`feed_ts < ?`)
    params.push(filter.to)
  }
  if (filter.since !== undefined) {
    where.push(`first_seen_at >= ?`)
    params.push(filter.since)
  }
  if (cursor) {
    where.push(`(feed_ts, source_id, item_id) < (?, ?, ?)`)
    params.push(cursor.feedTs, cursor.sourceId, cursor.itemId)
  }
  return { where, params }
}

/**
 * 「范围」条件（来源集合、关键词、时间），写在别名 m 的 items 行上：定组的代表行时，组里别的条目也要满足同样的范围才算「更早的」。
 * 游标与 since 是位置（拉新用），不是范围，不在里面：客户端已有的老组来了新成员，since 查询不该把它当新行；标的按组判断（见 rowWhere），也不在里面。
 */
function memberScope(filter: FeedFilter) {
  const where: string[] = []
  const params: Primitive[] = []
  if (filter.sourceIds) {
    where.push(`m.source_id IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(filter.sourceIds))
  }
  for (const term of filter.keywords) {
    where.push(`(m.title LIKE ? ESCAPE '\\' OR m.clean_title LIKE ? ESCAPE '\\')`)
    params.push(`%${escapeLike(term)}%`, `%${escapeLike(term)}%`)
  }
  if (filter.from !== undefined) {
    where.push(`m.feed_ts >= ?`)
    params.push(filter.from)
  }
  if (filter.to !== undefined) {
    where.push(`m.feed_ts < ?`)
    params.push(filter.to)
  }
  if (!filter.includeFiltered) where.push(`m.filter_reason IS NULL`)
  const align = alignWhere("m.seq", filter)
  if (align) {
    where.push(align.sql)
    params.push(...align.params)
  }
  return { where, params }
}

/** 对齐条件：这条在（给了 market 就限定该市场的）某个交易日有对齐记录。col 是条目 seq 的列。 */
function alignWhere(col: string, filter: Pick<FeedFilter, "market" | "tradeDate">): { sql: string, params: Primitive[] } | undefined {
  if (!filter.market && !filter.tradeDate) return undefined
  const cond: string[] = []
  const params: Primitive[] = []
  if (filter.market) {
    cond.push(`a.market = ?`)
    params.push(filter.market)
  }
  if (filter.tradeDate) {
    cond.push(`a.trade_date = ?`)
    params.push(filter.tradeDate)
  }
  return { sql: `${col} IN (SELECT a.seq FROM item_align a WHERE ${cond.join(" AND ")})`, params }
}

/** 过滤条件（来源集合、关键词、标注……）：只能逐行判断。windowed：给「最新 SCAN_WINDOW 行」的窗口查询用（标注条件的写法不同，见下）。 */
function rowWhere(filter: FeedFilter, windowed: boolean) {
  const where: string[] = []
  const params: Primitive[] = []
  if (filter.sourceIds) {
    where.push(`source_id IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(filter.sourceIds))
  }
  for (const term of filter.keywords) {
    // 原始标题与清洗后的标题都找：实体没解码的原标题里搜不到 Trump's（&#8217;），清洗后的搜得到；反过来 Google 的来源后缀只在原标题里
    where.push(`(title LIKE ? ESCAPE '\\' OR clean_title LIKE ? ESCAPE '\\')`)
    params.push(`%${escapeLike(term)}%`, `%${escapeLike(term)}%`)
  }
  if (!filter.includeFiltered) where.push(`filter_reason IS NULL`)
  const align = alignWhere("items.seq", filter)
  if (align) {
    where.push(align.sql)
    params.push(...align.params)
  }
  if (filter.impact?.length || filter.direction?.length) {
    // 标注挂在组的主条目上，按组判断（组 id = 主条目的 seq）。写法有两种，各有一种病态情形（200 万行级的合成库上量过，见 test/enrich/perf.test.ts）：
    // - 逐行探主键（窗口查询用）：对每个候选行查它所在组的主条目是否命中。常见的类型几百行里就凑够一页，快；罕见的类型要扫完整个信息流索引，慢。
    // - 先取出命中的主条目集合 G，再按 seq ∈ G 或 dup_of ∈ G 匹配（兜底的整查询用，写法同下面的标的，走主键与 idx_items_dup_of）：集合小（罕见）时快，集合大（常见）时光是建集合就慢。
    // 窗口里凑够一页说明命中的不稀少，用前一种；窗口里凑不够才落到整查询，命中的多半稀少，用后一种。
    const cond: string[] = []
    const own: Primitive[] = []
    if (filter.impact?.length) {
      cond.push(`t.impact IN (SELECT value FROM json_each(?))`)
      own.push(JSON.stringify(filter.impact))
    }
    if (filter.direction?.length) {
      cond.push(`t.direction IN (SELECT value FROM json_each(?))`)
      own.push(JSON.stringify(filter.direction))
    }
    if (windowed) {
      where.push(`EXISTS (SELECT 1 FROM items t WHERE t.seq = COALESCE(items.dup_of, items.seq) AND ${cond.join(" AND ")})`)
      params.push(...own)
    } else {
      const tagged = `SELECT t.seq FROM items t WHERE ${cond.join(" AND ")}`
      where.push(`(items.seq IN (${tagged}) OR items.dup_of IN (${tagged}))`)
      params.push(...own, ...own)
    }
  }
  if (!filter.expand) {
    const scope = memberScope(filter)
    if (scope.where.length) {
      // 先按范围（来源 / 关键词 / 时间）筛、再在范围里收拢：组的代表行 = 范围内 seq 最小的那条。主条目在范围里它就是代表；
      // 不在，范围里最早的成员是代表（后到的成员 seq 只会更大，代表定下后不再变，游标稳定）。
      where.push(`(items.dup_of IS NULL OR NOT EXISTS (
        SELECT 1 FROM items m WHERE (m.seq = items.dup_of OR m.dup_of = items.dup_of) AND m.seq < items.seq AND ${scope.where.join(" AND ")}))`)
      params.push(...scope.params)
    } else {
      where.push(`items.dup_of IS NULL`)
    }
  }
  if (filter.symbols.length) {
    const symbols = JSON.stringify(filter.symbols)
    const own = `SELECT seq FROM item_symbols WHERE symbol IN (SELECT value FROM json_each(?))`
    if (filter.expand) {
      where.push(`seq IN (${own})`)
      params.push(symbols)
    } else {
      // 按组判断：先算出带这些标的的组 id 集合 G（组 id = 主条目的 seq），再按 seq ∈ G 或 dup_of ∈ G 匹配，两边分别走主键与 idx_items_dup_of。
      // 不写成 COALESCE(dup_of, seq) IN (…)：表达式用不上索引，罕见标的会扫全库（300k 行实测 3 ms -> 88 ms，#9 审阅）。
      // 前提：成员的 dup_of 直接指向主条目、不成链（enrich.ts 保证，test/enrich/perf.test.ts 断言）；成链的话 dup_of ∈ G 会漏掉链尾。
      const groupsWith = `SELECT COALESCE(i.dup_of, i.seq) FROM items i WHERE i.seq IN (${own})`
      where.push(`(items.seq IN (${groupsWith}) OR items.dup_of IN (${groupsWith}))`)
      params.push(symbols, symbols)
    }
  }
  return { where, params }
}

const clause = (where: string[]) => where.length ? `WHERE ${where.join(" AND ")}` : ""
const ORDER = `ORDER BY feed_ts DESC, source_id DESC, item_id DESC`

/**
 * 先在最新的 SCAN_WINDOW 行里找：沿 idx_items_feed 倒着读，边读边过滤，凑够一页就停。
 * 不这样做的话，来源集合一进 WHERE，SQLite 会改成「按来源索引取出这些源的全部行再整体排序」，
 * 耗时随库的大小线性涨（实测 20 万条时首屏 34 ms，10 万条以上就会超 200 ms 的目标；1 万条 3 ms）。
 * 窗口里凑不够一页（过滤条件很窄、或真的到底了）才用不限窗口的整查询兜底，兜底只在这种少见的情况下付代价。
 * 窗口大小待定：2000 行读一遍在毫秒级，默认全量来源下一页 50 条通常在前几百行里就凑够。
 */
export const SCAN_WINDOW = 2000

export class FeedStore {
  private enrich: EnrichStore

  constructor(private db: Database, private scanWindow = SCAN_WINDOW) {
    this.enrich = new EnrichStore(db)
  }

  /** 目前已分配的最大 seq，没有条目是 0。 */
  async latestSeq(): Promise<number> {
    const row = await this.db.prepare(`SELECT MAX(seq) AS seq FROM items`).get() as { seq: number | null } | undefined
    return row?.seq ?? 0
  }

  async page(filter: FeedFilter, limit: number, cursor?: FeedCursor): Promise<FeedPage> {
    if (filter.sourceIds && !filter.sourceIds.length) return { rows: [], hasMore: false, groups: new Map() }
    const range = rangeWhere(filter, cursor)
    const row = rowWhere(filter, true)
    const rowFull = rowWhere(filter, false)
    const run = async (sql: string, params: Primitive[]) => rowsOf<Record<string, any>>(await this.db.prepare(sql).all(...params))
    let rows: Record<string, any>[] = []
    let done = false
    if (row.where.length) {
      rows = await run(`
        SELECT ${ITEM_SELECT} FROM (
          SELECT ${ITEM_SELECT} FROM items ${clause(range.where)} ${ORDER} LIMIT ${this.scanWindow}
        ) AS items ${clause(row.where)} ${ORDER} LIMIT ?
      `, [...range.params, ...row.params, limit + 1])
      done = rows.length > limit
    }
    if (!done) {
      rows = await run(`
        SELECT ${ITEM_SELECT} FROM items ${clause([...range.where, ...rowFull.where])} ${ORDER} LIMIT ?
      `, [...range.params, ...rowFull.params, limit + 1])
    }
    const items = rows.slice(0, limit).map(itemFromRow)
    await this.enrich.hydrate(items)
    return { rows: items, hasMore: rows.length > limit, groups: await this.groupsOf(items) }
  }

  /** 这些条目所在的组（成员条目取它的主条目的组）。 */
  async groupsOf(items: IngestedItem[]): Promise<Map<number, GroupInfo>> {
    return this.enrich.groups(items.map(i => i.dupOf ?? i.seq))
  }

  /** 这些主条目 seq 的组（SSE 的 merge 事件要来源数）。 */
  groups(mainSeqs: number[]): Promise<Map<number, GroupInfo>> {
    return this.enrich.groups(mainSeqs)
  }

  /**
   * SSE 用：这个组（主条目 seq = groupId）里有没有比 beforeSeq 更早的、满足订阅范围（来源、关键词）的条目，
   * 有就说明客户端已经见过这个组的代表行，新成员只推 merge。
   */
  async earlierInScope(groupId: number, beforeSeq: number, filter: Pick<FeedFilter, "sourceIds" | "keywords" | "includeFiltered">): Promise<boolean> {
    const scope = memberScope({ ...filter, symbols: [], expand: false })
    const row = await this.db.prepare(`
      SELECT 1 AS hit FROM items m WHERE (m.seq = ? OR m.dup_of = ?) AND m.seq < ? ${scope.where.length ? `AND ${scope.where.join(" AND ")}` : ""} LIMIT 1
    `).get(groupId, groupId, beforeSeq, ...scope.params)
    return !!row
  }

  /** SSE 用：这个组（主条目 seq = groupId）里任一条目（给了 beforeSeq 时只看 seq 更小的）带 symbols 之一。 */
  async groupHasSymbol(groupId: number, symbols: string[], beforeSeq?: number): Promise<boolean> {
    const row = await this.db.prepare(`
      SELECT 1 AS hit FROM item_symbols WHERE symbol IN (SELECT value FROM json_each(?))
        AND seq IN (SELECT seq FROM items WHERE (seq = ? OR dup_of = ?) AND seq < ?) LIMIT 1
    `).get(JSON.stringify(symbols), groupId, groupId, beforeSeq ?? Number.MAX_SAFE_INTEGER)
    return !!row
  }

  /** SSE 用：这个组在订阅范围（来源、关键词）里的代表行（范围内 seq 最小的那条）；范围里没有返回 undefined。 */
  async representative(groupId: number, filter: Pick<FeedFilter, "sourceIds" | "keywords" | "includeFiltered">): Promise<IngestedItem | undefined> {
    const scope = memberScope({ ...filter, symbols: [], expand: false })
    const rows = rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${ITEM_SELECT} FROM items m WHERE (m.seq = ? OR m.dup_of = ?) ${scope.where.length ? `AND ${scope.where.join(" AND ")}` : ""} ORDER BY m.seq LIMIT 1
    `).all(groupId, groupId, ...scope.params))
    const items = rows.map(itemFromRow)
    await this.enrich.hydrate(items)
    return items[0]
  }

  /** seq 大于 after 的条目，按 seq 升序（SSE 补发用）。 */
  async after(seq: number, limit: number): Promise<IngestedItem[]> {
    const items = rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${ITEM_SELECT} FROM items WHERE seq > ? ORDER BY seq LIMIT ?
    `).all(seq, limit)).map(itemFromRow)
    await this.enrich.hydrate(items)
    return items
  }
}
