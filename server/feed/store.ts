import type { Database, Primitive } from "db0"
import { ITEM_SELECT, itemFromRow } from "#/collector/store"
import type { IngestedItem } from "#/collector/store"
import { EnrichStore } from "#/enrich/store"
import type { GroupInfo } from "#/enrich/store"

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

/** 过滤条件（来源集合、关键词）：只能逐行判断。 */
function rowWhere(filter: FeedFilter) {
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
  if (!filter.expand) {
    if (filter.sourceIds) {
      // 先按来源范围筛、再在范围里收拢：组的代表行 = 范围内 seq 最小的那条。主条目在范围里它就是代表；
      // 不在，范围里最早的成员是代表（后到的成员 seq 只会更大，代表定下后不再变，游标稳定）。
      where.push(`(items.dup_of IS NULL OR NOT EXISTS (
        SELECT 1 FROM items m WHERE (m.seq = items.dup_of OR m.dup_of = items.dup_of) AND m.seq < items.seq
          AND m.source_id IN (SELECT value FROM json_each(?))))`)
      params.push(JSON.stringify(filter.sourceIds))
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
      // 组里任何一条带这个标的，主条目就算命中
      where.push(`seq IN (${own} UNION SELECT dup_of FROM items WHERE dup_of IS NOT NULL AND seq IN (${own}))`)
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
    const row = rowWhere(filter)
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
        SELECT ${ITEM_SELECT} FROM items ${clause([...range.where, ...row.where])} ${ORDER} LIMIT ?
      `, [...range.params, ...row.params, limit + 1])
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

  /** seq 大于 after 的条目，按 seq 升序（SSE 补发用）。 */
  async after(seq: number, limit: number): Promise<IngestedItem[]> {
    const items = rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${ITEM_SELECT} FROM items WHERE seq > ? ORDER BY seq LIMIT ?
    `).all(seq, limit)).map(itemFromRow)
    await this.enrich.hydrate(items)
    return items
  }
}
