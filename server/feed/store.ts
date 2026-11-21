import type { Database, Primitive } from "db0"
import { ITEM_SELECT, itemFromRow } from "#/collector/store"
import type { IngestedItem } from "#/collector/store"

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
  /** 标题须包含每一个词（AND，不分大小写仅对 ASCII 生效：SQLite LIKE 的限制） */
  keywords: string[]
}

export interface FeedPage {
  rows: IngestedItem[]
  /** 还有更早的条目；nextCursor 由最后一条算出 */
  hasMore: boolean
}

function rowsOf<T>(res: unknown): T[] {
  const rows = (res as { results?: unknown })?.results ?? res
  return Array.isArray(rows) ? rows as T[] : []
}

const escapeLike = (term: string) => term.replace(/[\\%_]/g, c => `\\${c}`)

export function buildWhere(filter: FeedFilter, cursor?: FeedCursor) {
  const where: string[] = []
  const params: Primitive[] = []
  if (filter.sourceIds) {
    where.push(`source_id IN (SELECT value FROM json_each(?))`)
    params.push(JSON.stringify(filter.sourceIds))
  }
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
  for (const term of filter.keywords) {
    where.push(`title LIKE ? ESCAPE '\\'`)
    params.push(`%${escapeLike(term)}%`)
  }
  if (cursor) {
    where.push(`(feed_ts, source_id, item_id) < (?, ?, ?)`)
    params.push(cursor.feedTs, cursor.sourceId, cursor.itemId)
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params }
}

export class FeedStore {
  constructor(private db: Database) {}

  /** 目前已分配的最大 seq，没有条目是 0。 */
  async latestSeq(): Promise<number> {
    const row = await this.db.prepare(`SELECT MAX(seq) AS seq FROM items`).get() as { seq: number | null } | undefined
    return row?.seq ?? 0
  }

  async page(filter: FeedFilter, limit: number, cursor?: FeedCursor): Promise<FeedPage> {
    if (filter.sourceIds && !filter.sourceIds.length) return { rows: [], hasMore: false }
    const { sql, params } = buildWhere(filter, cursor)
    const rows = rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${ITEM_SELECT} FROM items ${sql}
      ORDER BY feed_ts DESC, source_id DESC, item_id DESC
      LIMIT ?
    `).all(...params, limit + 1))
    return { rows: rows.slice(0, limit).map(itemFromRow), hasMore: rows.length > limit }
  }

  /** seq 大于 after 的条目，按 seq 升序（SSE 补发用）。 */
  async after(seq: number, limit: number): Promise<IngestedItem[]> {
    return rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${ITEM_SELECT} FROM items WHERE seq > ? ORDER BY seq LIMIT ?
    `).all(seq, limit)).map(itemFromRow)
  }
}
