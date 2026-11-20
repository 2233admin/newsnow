import { Buffer } from "node:buffer"
import type { NewsItem } from "@shared/types"
import type { Database } from "db0"

/**
 * 观测库：采集到的每条新闻都落库，不覆盖。
 *
 * 上游的 cache 表每个源只留最新一份（INSERT OR REPLACE），没有历史。这里补两张表：
 * - items：每条新闻一行，记首次与最近一次出现的时间。热榜类的源没有发布时间，用首次出现时间排进时间流。
 * - observations：名次变化的记录。只在新出现或名次变了时写一行，名次没变不写，
 *   否则一个 2 分钟采一次的源一天要写两万多行重复数据。
 * 另有 source_health：每个源最近一次采集成功与失败的情况。
 */

export interface FeedItem {
  source: string
  id: string
  title: string
  url: string
  mobileUrl?: string
  /** 来源给的发布时间（毫秒）。来源没给或解析不了就没有。 */
  pubDate?: number
  /** 我们第一次采到它的时间（毫秒）。 */
  firstSeen: number
  /** 最近一次采到它的时间（毫秒）。 */
  lastSeen: number
  /** 排进时间流用的时间：有发布时间用发布时间，没有用首次出现时间。 */
  time: number
  /** 最近一次采到时在这个源里的名次，从 1 起。 */
  rank: number
  extra?: NewsItem["extra"]
}

export interface RankPoint {
  observedAt: number
  rank: number
}

export interface SourceHealth {
  source: string
  lastSuccess?: number
  lastFailure?: number
  consecutiveFailures: number
  lastError?: string
  lastItemCount?: number
}

export interface FeedQuery {
  /** 翻页：传上一页返回的 nextCursor，接着往更早的翻。 */
  cursor?: string
  /** 只要排序时间早于它的（毫秒）。 */
  before?: number
  /** 只要排序时间晚于它的（毫秒）；拉新消息时用。 */
  after?: number
  sources?: string[]
  /** 默认 50，最多 200。 */
  limit?: number
}

interface ItemRow {
  source: string
  item_id: string
  title: string
  url: string
  mobile_url: string | null
  pub_date: number | null
  first_seen: number
  last_seen: number
  sort_time: number
  rank: number
  extra: string | null
}

export const FEED_LIMIT_DEFAULT = 50
export const FEED_LIMIT_MAX = 200

/** 发布时间比采集时间晚超过这么多就不信（来源的时钟或时区写错了），改用首次出现时间。 */
const FUTURE_TOLERANCE = 10 * 60 * 1000

/**
 * 把来源给的发布时间换成毫秒。来源有的给毫秒、有的给秒、有的给日期字符串；解析不了返回 undefined。
 */
export function parsePubDate(value: NewsItem["pubDate"], now: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  let ms: number
  if (typeof value === "number") {
    ms = value
  } else if (/^\d+$/.test(value.trim())) {
    ms = Number(value.trim())
  } else {
    ms = Date.parse(value)
  }
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  // 10 位是秒：2001 年之后的毫秒时间戳都在 1e12 以上。
  if (ms < 1e11) ms *= 1000
  if (ms > now + FUTURE_TOLERANCE) return undefined
  return ms
}

function rows<T>(res: unknown): T[] {
  // Cloudflare D1 的 .all() 返回 { results }，别的连接器直接返回数组（同 database/cache.ts）。
  return ((res as { results?: T[] })?.results ?? res ?? []) as T[]
}

type CursorKey = [time: number, source: string, id: string]

function encodeCursor(item: FeedItem): string {
  return Buffer.from(JSON.stringify([item.time, item.source, item.id] satisfies CursorKey)).toString("base64url")
}

/** 解不出来就抛错，由接口回 400；不悄悄当成从头翻。 */
export function decodeCursor(cursor: string): CursorKey {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid cursor")
  }
  if (!Array.isArray(parsed) || parsed.length !== 3
    || typeof parsed[0] !== "number" || typeof parsed[1] !== "string" || typeof parsed[2] !== "string") {
    throw new Error("Invalid cursor")
  }
  return parsed as CursorKey
}

function toFeedItem(row: ItemRow): FeedItem {
  return {
    source: row.source,
    id: row.item_id,
    title: row.title,
    url: row.url,
    ...(row.mobile_url ? { mobileUrl: row.mobile_url } : {}),
    ...(row.pub_date ? { pubDate: row.pub_date } : {}),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    time: row.sort_time,
    rank: row.rank,
    ...(row.extra ? { extra: JSON.parse(row.extra) as NewsItem["extra"] } : {}),
  }
}

export class ObservationStore {
  private db
  constructor(db: Database) {
    this.db = db
  }

  async init() {
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS items (
        source TEXT NOT NULL,
        item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        mobile_url TEXT,
        pub_date INTEGER,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        sort_time INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        extra TEXT,
        PRIMARY KEY (source, item_id)
      );
    `).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS items_sort_time ON items (sort_time DESC, source DESC, item_id DESC);`).run()
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS observations (
        source TEXT NOT NULL,
        item_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        rank INTEGER NOT NULL
      );
    `).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS observations_item ON observations (source, item_id, observed_at);`).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS observations_time ON observations (observed_at);`).run()
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY,
        last_success INTEGER,
        last_failure INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_item_count INTEGER
      );
    `).run()
  }

  /**
   * 记一次采集的结果。返回这次新出现的条数。
   * 同一批里 id 重复的只认第一条（名次靠前的那条）。
   */
  async record(source: string, items: NewsItem[], now: number): Promise<number> {
    let added = 0
    const seen = new Set<string>()
    for (const [index, item] of items.entries()) {
      const itemId = String(item.id)
      if (seen.has(itemId)) continue
      seen.add(itemId)
      const rank = index + 1
      const pubDate = parsePubDate(item.pubDate, now)
      const existing = await this.db.prepare(
        `SELECT rank FROM items WHERE source = ? AND item_id = ?`,
      ).get(source, itemId) as { rank: number } | undefined

      if (!existing) {
        added++
        await this.db.prepare(`
          INSERT INTO items (source, item_id, title, url, mobile_url, pub_date, first_seen, last_seen, sort_time, rank, extra)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          source,
          itemId,
          item.title,
          item.url,
          item.mobileUrl ?? null,
          pubDate ?? null,
          now,
          now,
          pubDate ?? now,
          rank,
          item.extra ? JSON.stringify(item.extra) : null,
        )
      } else {
        // 排序时间在第一次入库时定下，之后不改：条目在时间流里的位置不能跳。
        await this.db.prepare(`
          UPDATE items SET title = ?, url = ?, mobile_url = ?, last_seen = ?, rank = ?, extra = ?
          WHERE source = ? AND item_id = ?
        `).run(
          item.title,
          item.url,
          item.mobileUrl ?? null,
          now,
          rank,
          item.extra ? JSON.stringify(item.extra) : null,
          source,
          itemId,
        )
      }

      if (!existing || existing.rank !== rank) {
        await this.db.prepare(
          `INSERT INTO observations (source, item_id, observed_at, rank) VALUES (?, ?, ?, ?)`,
        ).run(source, itemId, now, rank)
      }
    }
    return added
  }

  /** 时间流：按排序时间从新到旧。 */
  async feed(query: FeedQuery = {}): Promise<{ items: FeedItem[], nextCursor?: string }> {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? FEED_LIMIT_DEFAULT), 1), FEED_LIMIT_MAX)
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.cursor !== undefined) {
      // 同一毫秒可以有很多条（一批热榜条目同时入库），只按时间翻页会漏，所以按（时间、源、id）三项接着翻。
      where.push(`(sort_time, source, item_id) < (?, ?, ?)`)
      params.push(...decodeCursor(query.cursor))
    }
    if (query.before !== undefined) {
      where.push(`sort_time < ?`)
      params.push(query.before)
    }
    if (query.after !== undefined) {
      where.push(`sort_time > ?`)
      params.push(query.after)
    }
    if (query.sources?.length) {
      where.push(`source IN (${query.sources.map(() => "?").join(", ")})`)
      params.push(...query.sources)
    }
    const sql = `
      SELECT * FROM items
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY sort_time DESC, source DESC, item_id DESC
      LIMIT ?
    `
    // 多取一条用来判断还有没有下一页。
    const found = rows<ItemRow>(await this.db.prepare(sql).all(...params, limit + 1))
    const page = found.slice(0, limit).map(toFeedItem)
    const last = page.at(-1)
    return {
      items: page,
      ...(found.length > limit && last ? { nextCursor: encodeCursor(last) } : {}),
    }
  }

  /** 一条新闻的名次变化，从早到晚。 */
  async rankHistory(source: string, itemId: string): Promise<RankPoint[]> {
    const found = rows<{ observed_at: number, rank: number }>(await this.db.prepare(
      `SELECT observed_at, rank FROM observations WHERE source = ? AND item_id = ? ORDER BY observed_at ASC`,
    ).all(source, itemId))
    return found.map(r => ({ observedAt: r.observed_at, rank: r.rank }))
  }

  async recordSuccess(source: string, itemCount: number, now: number) {
    await this.db.prepare(`
      INSERT INTO source_health (source, last_success, consecutive_failures, last_item_count)
      VALUES (?, ?, 0, ?)
      ON CONFLICT (source) DO UPDATE SET
        last_success = excluded.last_success,
        consecutive_failures = 0,
        last_item_count = excluded.last_item_count
    `).run(source, now, itemCount)
  }

  async recordFailure(source: string, error: string, now: number) {
    await this.db.prepare(`
      INSERT INTO source_health (source, last_failure, consecutive_failures, last_error)
      VALUES (?, ?, 1, ?)
      ON CONFLICT (source) DO UPDATE SET
        last_failure = excluded.last_failure,
        consecutive_failures = source_health.consecutive_failures + 1,
        last_error = excluded.last_error
    `).run(source, now, error.slice(0, 500))
  }

  async health(): Promise<SourceHealth[]> {
    const found = rows<{
      source: string
      last_success: number | null
      last_failure: number | null
      consecutive_failures: number
      last_error: string | null
      last_item_count: number | null
    }>(await this.db.prepare(`SELECT * FROM source_health ORDER BY source ASC`).all())
    return found.map(r => ({
      source: r.source,
      ...(r.last_success ? { lastSuccess: r.last_success } : {}),
      ...(r.last_failure ? { lastFailure: r.last_failure } : {}),
      consecutiveFailures: r.consecutive_failures,
      ...(r.last_error ? { lastError: r.last_error } : {}),
      ...(r.last_item_count !== null ? { lastItemCount: r.last_item_count } : {}),
    }))
  }

  /** 删掉早于 cutoff 的名次记录。items 不删。 */
  async pruneObservations(cutoff: number) {
    await this.db.prepare(`DELETE FROM observations WHERE observed_at < ?`).run(cutoff)
  }
}
