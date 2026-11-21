import type { Database } from "db0"
import type { NewsItem } from "@shared/types"

/**
 * 观测库：每次采集都落库，不覆盖（#2184）。
 *
 * - items：每条新闻一行，(source_id, item_id) 唯一；first_seen_at 是入流时间，永久保留。
 * - observations：每次看到某条目一行（名次与附加信息），按保留天数清理。
 * - source_health：每个源一行，最近成功时间、连续失败次数、最近错误。
 *
 * SQL 一律参数化，只用 SQLite 与 Cloudflare D1 共有的语法（INSERT OR IGNORE、ON CONFLICT DO UPDATE）。
 * 多行 INSERT 按 D1 的 100 个绑定参数上限分块；不用 BEGIN/COMMIT，因为 D1 不支持，
 * 也因为多个源并发写同一个连接时事务会互相夹带。靠主键让重试幂等。
 */

/** D1 单条语句最多 100 个绑定参数（https://developers.cloudflare.com/d1/platform/limits/ ，读取日期 2026-11-21）。 */
const D1_MAX_PARAMS = 100
const ITEM_COLUMNS = 7
const OBSERVATION_COLUMNS = 5
const ITEM_ROWS_PER_STATEMENT = Math.floor(D1_MAX_PARAMS / ITEM_COLUMNS)
const OBSERVATION_ROWS_PER_STATEMENT = Math.floor(D1_MAX_PARAMS / OBSERVATION_COLUMNS)

/**
 * 错误信息里的 URL 只留 origin + path：查询串里可能有 token、签名或 cookie 参数，不该落库、也不该经健康接口出去。
 */
export function stripUrlQueries(message: string) {
  return message.replace(/https?:\/\/[^\s"'<>)]+/g, (raw) => {
    try {
      const u = new URL(raw)
      return u.origin + u.pathname
    } catch {
      return raw.split(/[?#]/)[0]
    }
  })
}

/** 记在 source_health.last_error 里的最大长度，避免把整页 HTML 错误体写进库。 */
const MAX_ERROR_LENGTH = 500

export interface ObservedRow {
  itemId: string
  title: string
  url: string | null
  pubDate: number | null
  rank: number
  extra: string | null
}

export interface ItemRecord {
  sourceId: string
  itemId: string
  title: string
  url: string | null
  pubDate: number | null
  firstSeenAt: number
  lastSeenAt: number
}

export interface ObservationRecord {
  observedAt: number
  rank: number
  extra: unknown
}

export interface ItemHistory {
  item: ItemRecord
  observations: ObservationRecord[]
}

export interface HealthRecord {
  sourceId: string
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  consecutiveFailures: number
  lastError: string | null
  lastErrorAt: number | null
  lastItemCount: number | null
}

/**
 * Cloudflare D1 的 .all() 返回 { results }，其余连接器直接返回数组；
 * 见 https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/#return-object（同 server/database/cache.ts）。
 */
function rowsOf<T>(res: unknown): T[] {
  const rows = (res as { results?: unknown })?.results ?? res
  return Array.isArray(rows) ? rows as T[] : []
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function placeholders(columns: number, rows: number) {
  const one = `(${Array.from({ length: columns }, () => "?").join(",")})`
  return Array.from({ length: rows }, () => one).join(",")
}

/**
 * 适配器给的 pubDate 可能是毫秒数、RFC 日期串或没有；统一成毫秒数，认不出的记 null。
 * 没带时区的字符串按服务器本地时区解析，是已知的不精确（适配器各自负责给出带时区的值）。
 */
export function toTimestamp(value: NewsItem["pubDate"] | undefined): number | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * 整理适配器返回的条目：缺 id 或标题的丢掉，同一 id 只留第一次出现（名次取它的位置），
 * 名次从 1 起，按去重后的顺序。
 */
export function toObservedRows(items: NewsItem[], limit: number): ObservedRow[] {
  const seen = new Set<string>()
  const rows: ObservedRow[] = []
  for (const item of items) {
    if (rows.length >= limit) break
    const itemId = item?.id === undefined || item.id === null ? "" : String(item.id)
    const title = typeof item?.title === "string" ? item.title.trim() : ""
    if (!itemId || !title || seen.has(itemId)) continue
    seen.add(itemId)
    rows.push({
      itemId,
      title,
      url: item.url ? String(item.url) : null,
      pubDate: toTimestamp(item.pubDate),
      rank: rows.length + 1,
      extra: item.extra ? JSON.stringify(item.extra) : null,
    })
  }
  return rows
}

export class ObservationStore {
  constructor(private db: Database) {}

  async init() {
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS items (
        source_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        pub_date INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, item_id)
      )
    `).run()
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS observations (
        source_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        extra TEXT,
        PRIMARY KEY (source_id, item_id, observed_at)
      )
    `).run()
    // 按保留天数清理时按时间范围删除
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_observations_observed_at ON observations (observed_at)`).run()
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS source_health (
        source_id TEXT PRIMARY KEY,
        last_attempt_at INTEGER,
        last_success_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_at INTEGER,
        last_item_count INTEGER
      )
    `).run()
  }

  /**
   * 落一次采集：每条写 items（首次出现记 first_seen_at，之后只更新标题、链接、last_seen_at，发布时间有值才覆盖）
   * 与 observations（本次名次）。同一 (source, item, observedAt) 重复写入会被忽略，所以重试是幂等的。
   */
  async recordObservations(sourceId: string, rows: ObservedRow[], observedAt: number) {
    for (const part of chunk(rows, ITEM_ROWS_PER_STATEMENT)) {
      const params = part.flatMap(r => [sourceId, r.itemId, r.title, r.url, r.pubDate, observedAt, observedAt])
      await this.db.prepare(`
        INSERT INTO items (source_id, item_id, title, url, pub_date, first_seen_at, last_seen_at)
        VALUES ${placeholders(ITEM_COLUMNS, part.length)}
        ON CONFLICT (source_id, item_id) DO UPDATE SET
          title = excluded.title,
          url = COALESCE(excluded.url, items.url),
          pub_date = COALESCE(excluded.pub_date, items.pub_date),
          last_seen_at = excluded.last_seen_at
      `).run(...params)
    }
    for (const part of chunk(rows, OBSERVATION_ROWS_PER_STATEMENT)) {
      const params = part.flatMap(r => [sourceId, r.itemId, observedAt, r.rank, r.extra])
      await this.db.prepare(`
        INSERT OR IGNORE INTO observations (source_id, item_id, observed_at, rank, extra)
        VALUES ${placeholders(OBSERVATION_COLUMNS, part.length)}
      `).run(...params)
    }
  }

  async recordSuccess(sourceId: string, attemptAt: number, itemCount: number) {
    await this.db.prepare(`
      INSERT INTO source_health (source_id, last_attempt_at, last_success_at, consecutive_failures, last_item_count)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT (source_id) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = excluded.last_success_at,
        consecutive_failures = 0,
        last_item_count = excluded.last_item_count
    `).run(sourceId, attemptAt, attemptAt, itemCount)
  }

  async recordFailure(sourceId: string, attemptAt: number, error: unknown) {
    const message = stripUrlQueries(error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)
    await this.db.prepare(`
      INSERT INTO source_health (source_id, last_attempt_at, consecutive_failures, last_error, last_error_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT (source_id) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        consecutive_failures = source_health.consecutive_failures + 1,
        last_error = excluded.last_error,
        last_error_at = excluded.last_error_at
    `).run(sourceId, attemptAt, message, attemptAt)
  }

  /** 删掉一个源的健康记录（用户源被删除或改了地址时）；条目与观测不动。 */
  async deleteHealth(sourceId: string) {
    await this.db.prepare(`DELETE FROM source_health WHERE source_id = ?`).run(sourceId)
  }

  /** 删掉 observed_at 早于 cutoff 的观测；items 永久保留，所以条目的首次出现时间不受影响。 */
  async purgeObservations(cutoff: number) {
    await this.db.prepare(`DELETE FROM observations WHERE observed_at < ?`).run(cutoff)
  }

  async getHealth(): Promise<HealthRecord[]> {
    const rows = rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT source_id, last_attempt_at, last_success_at, consecutive_failures, last_error, last_error_at, last_item_count
      FROM source_health ORDER BY source_id
    `).all())
    return rows.map(r => ({
      sourceId: r.source_id,
      lastAttemptAt: r.last_attempt_at,
      lastSuccessAt: r.last_success_at,
      consecutiveFailures: r.consecutive_failures,
      lastError: r.last_error,
      lastErrorAt: r.last_error_at,
      lastItemCount: r.last_item_count,
    }))
  }

  /** 一条新闻的首次出现时间与名次历史（名次历史只到保留期，更早的已清理）。 */
  async getItemHistory(sourceId: string, itemId: string): Promise<ItemHistory | undefined> {
    const row = await this.db.prepare(`
      SELECT source_id, item_id, title, url, pub_date, first_seen_at, last_seen_at
      FROM items WHERE source_id = ? AND item_id = ?
    `).get(sourceId, itemId) as Record<string, any> | undefined
    if (!row) return undefined
    const obs = rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT observed_at, rank, extra FROM observations
      WHERE source_id = ? AND item_id = ? ORDER BY observed_at
    `).all(sourceId, itemId))
    return {
      item: {
        sourceId: row.source_id,
        itemId: row.item_id,
        title: row.title,
        url: row.url,
        pubDate: row.pub_date,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      },
      observations: obs.map(o => ({
        observedAt: o.observed_at,
        rank: o.rank,
        extra: o.extra ? JSON.parse(o.extra) : null,
      })),
    }
  }
}
