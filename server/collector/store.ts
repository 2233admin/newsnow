import type { Database } from "db0"
import type { NewsItem } from "@shared/types"
import type { Align, FilterReason, ItemTags } from "../enrich/types"

/**
 * 观测库：每次采集都落库，不覆盖（#2184）。
 *
 * - items：每条新闻一行，(source_id, item_id) 唯一；永久保留。三个时间/序号字段各管一件事（#2186）：
 *   - first_seen_at：第一次被采集到的时间（毫秒），不变。
 *   - feed_ts：信息流的排序时间，插入时定下、之后不再改：有 pub_date 用 pub_date，没有（热榜、没带时间的源）用 first_seen_at；
 *     pub_date 晚于 first_seen_at 的（源站时钟快、时区解析偏差）按 first_seen_at 算，免得一条条目永远钉在流的顶端。
 *   - seq：入库顺序号（AUTOINCREMENT，单调、不复用），新条目入库时分配，SSE 的 Last-Event-ID 与「拉新」靠它。
 * - observations：每次看到某条目一行（名次与附加信息），按保留天数清理。
 * - source_health：每个源一行，最近成功时间、连续失败次数、最近错误。
 *
 * - 富化（#2188，server/enrich/）：items 另有 clean_title（清洗后的标题，原始 title 不改）、orig_url（解出的原文链接）、canon_url 与 title_key（去重键）、
 *   dup_of（这条是哪个主条目的成员：主条目的 seq；自己是主条目或没有重复的是 NULL）、enriched（0 = 还没富化；富化版本号）。
 *   标的在 item_symbols（symbol, seq）。富化在写库处同步跑（见 recordObservations），失败不影响入库，条目留 enriched = 0，之后用回填命令补。
 *
 * - 分类标注与对齐交易日（#2188 补充）：items 另有 filter_reason（规则层的过滤原因，NULL = 没被过滤）、impact / direction / gist / themes（批量标注层的结果，
 *   挂在组的主条目上；themes 是 JSON 数组文本）、tagged（0 = 还没标；标注版本号）、tag_attempts（标注失败的次数，到上限不再试）。
 *   对齐在 item_align（seq, market, trade_date, session），一条新闻涉及几个市场就几行；按需深读的缓存在 item_deep（seq, result, model, basis, created_at）。
 *   规则层与对齐是确定性的，和标的一起在写库处算（enrich.ts）；批量标注要调模型，不在写库的临界区里做，由 server/enrich/tagger.ts 异步补。
 *
 * SQL 一律参数化，只用 SQLite 与 Cloudflare D1 共有的语法（INSERT OR IGNORE、ON CONFLICT DO UPDATE）。
 * 多行 INSERT 按 D1 的 100 个绑定参数上限分块；不用 BEGIN/COMMIT，因为 D1 不支持，
 * 也因为多个源并发写同一个连接时事务会互相夹带。靠主键让重试幂等。
 */

/** D1 单条语句最多 100 个绑定参数（https://developers.cloudflare.com/d1/platform/limits/ ，读取日期 2026-11-21）。 */
const D1_MAX_PARAMS = 100
const ITEM_COLUMNS = 8
const OBSERVATION_COLUMNS = 5
const ITEM_ROWS_PER_STATEMENT = Math.floor(D1_MAX_PARAMS / ITEM_COLUMNS)
const OBSERVATION_ROWS_PER_STATEMENT = Math.floor(D1_MAX_PARAMS / OBSERVATION_COLUMNS)
/** 查已有条目：source_id 占 1 个参数，其余给 item_id。 */
const EXISTS_IDS_PER_STATEMENT = D1_MAX_PARAMS - 1
/** 批量更新已有条目：每行 4 个参数，另有 last_seen_at 与 source_id 两个。 */
const UPDATE_ROWS_PER_STATEMENT = Math.floor((D1_MAX_PARAMS - 2) / 4)

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

/** 新入库的条目（给信息流与 SSE 用）：比 ItemRecord 多了 seq、排序时间与富化结果。 */
export interface IngestedItem extends ItemRecord {
  seq: number
  feedTs: number
  /** 清洗后的标题（解码实体、去 Google News 来源后缀）；没富化过是 null */
  cleanTitle: string | null
  /** 解出的原文链接；解不出是 null */
  origUrl: string | null
  /** 主条目的 seq；自己是主条目或没有重复的是 null */
  dupOf: number | null
  /** 0 = 还没富化 */
  enriched: number
  /** 识别出的标的（品种 id「代码.场所」）；列表读出来时由 FeedStore 补上 */
  symbols: string[]
  /** 规则层的过滤原因；没被过滤是 null */
  filterReason: FilterReason | null
  /** 这条自己的标注（只有组的主条目会被标）；没标过是 null */
  tags: ItemTags | null
  /** 对齐的交易日（每个涉及的市场一项）；列表读出来时由 FeedStore 补上 */
  align: Align[]
}

/** 写库处的富化钩子（server/enrich/enrich.ts 实现）：在通知监听器之前原地填好条目的富化字段。抛错只记日志，条目留作未富化。 */
export interface ItemEnricher {
  enrich: (items: IngestedItem[]) => Promise<void>
  /** 已有条目的标题变了：清洗标题、标的、去重键跟着重算（分组不动） */
  retitle: (items: IngestedItem[]) => Promise<void>
}

export type IngestListener = (items: IngestedItem[]) => void

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

/** 信息流的排序时间，见文件头。 */
export function feedTimestamp(pubDate: number | null, firstSeenAt: number) {
  return pubDate !== null && pubDate < firstSeenAt ? pubDate : firstSeenAt
}

function ITEMS_DDL(name: string) {
  return `
  CREATE TABLE IF NOT EXISTS ${name} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    pub_date INTEGER,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    feed_ts INTEGER NOT NULL,
    clean_title TEXT,
    orig_url TEXT,
    canon_url TEXT,
    title_key TEXT,
    dup_of INTEGER,
    enriched INTEGER NOT NULL DEFAULT 0,
    filter_reason TEXT,
    impact TEXT,
    direction TEXT,
    gist TEXT,
    themes TEXT,
    tagged INTEGER NOT NULL DEFAULT 0,
    tag_attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source_id, item_id)
  )
`
}

export function itemFromRow(r: Record<string, any>): IngestedItem {
  return {
    seq: r.seq,
    sourceId: r.source_id,
    itemId: r.item_id,
    title: r.title,
    url: r.url,
    pubDate: r.pub_date,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    feedTs: r.feed_ts,
    cleanTitle: r.clean_title ?? null,
    origUrl: r.orig_url ?? null,
    dupOf: r.dup_of ?? null,
    enriched: r.enriched ?? 0,
    symbols: [],
    filterReason: r.filter_reason ?? null,
    tags: tagsFromRow(r),
    align: [],
  }
}

/** 一行里的标注字段 → ItemTags；tagged = 0（没标过）是 null。 */
export function tagsFromRow(r: Record<string, any>): ItemTags | null {
  if (!(r.tagged > 0)) return null
  let themes: string[] | null = null
  if (typeof r.themes === "string") {
    try {
      const parsed = JSON.parse(r.themes)
      if (Array.isArray(parsed)) themes = parsed.filter((x): x is string => typeof x === "string")
    } catch {}
  }
  return { impact: r.impact ?? null, direction: r.direction ?? null, gist: r.gist ?? null, themes }
}

export const ITEM_SELECT = `seq, source_id, item_id, title, url, pub_date, first_seen_at, last_seen_at, feed_ts, clean_title, orig_url, dup_of, enriched, filter_reason, impact, direction, gist, themes, tagged`

/** 富化加的列（#2188）：旧表用 ALTER TABLE 补，新表的 DDL 里已有。 */
const ENRICH_COLUMNS: [name: string, ddl: string][] = [
  ["clean_title", "TEXT"],
  ["orig_url", "TEXT"],
  ["canon_url", "TEXT"],
  ["title_key", "TEXT"],
  ["dup_of", "INTEGER"],
  ["enriched", "INTEGER NOT NULL DEFAULT 0"],
  // 分类标注（#2188 补充）
  ["filter_reason", "TEXT"],
  ["impact", "TEXT"],
  ["direction", "TEXT"],
  ["gist", "TEXT"],
  ["themes", "TEXT"],
  ["tagged", "INTEGER NOT NULL DEFAULT 0"],
  ["tag_attempts", "INTEGER NOT NULL DEFAULT 0"],
]

export class ObservationStore {
  private listeners = new Set<IngestListener>()
  /** 入库 + 取回新条目 + 通知要在一个临界区里：否则两个源的批次交错，通知的 seq 顺序会和入库顺序不同，按「最大 seq」续传的客户端会漏条。 */
  private ingestChain: Promise<unknown> = Promise.resolve()
  private enricher: ItemEnricher | undefined

  constructor(private db: Database) {}

  /** 装上富化器：之后每批新条目入库时同步富化（运行时装配见 collector/runtime.ts）。 */
  setEnricher(enricher: ItemEnricher | undefined) {
    this.enricher = enricher
  }

  /** 订阅新条目入库（采集器写库处触发，不轮询库）。返回取消订阅函数。监听器抛错不影响入库。 */
  onIngest(listener: IngestListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ingestChain.then(fn, fn)
    this.ingestChain = run.catch(() => {})
    return run
  }

  async init() {
    await this.migrateItems()
    await this.migrateEnrichColumns()
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
    // 信息流：按 (feed_ts, source_id, item_id) 倒序翻页；单源翻页；按入库时间拉新、找刚入库的一批（见 recordObservations）
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_feed ON items (feed_ts, source_id, item_id)`).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_source_feed ON items (source_id, feed_ts, item_id)`).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_first_seen ON items (first_seen_at)`).run()
    // 富化（#2188）：去重键的查找、按主条目取成员、按标的取条目
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_canon_url ON items (canon_url)`).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_title_key ON items (title_key)`).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_dup_of ON items (dup_of)`).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_enriched ON items (enriched, seq)`).run()
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS item_symbols (
        symbol TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (symbol, seq)
      ) WITHOUT ROWID
    `).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_item_symbols_seq ON item_symbols (seq)`).run()
    // 分类标注与对齐（#2188 补充）：待标注的按 (tagged, seq) 取；按影响类型 / 方向筛；对齐按 (交易日, 市场) 筛、按 seq 取
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_tagged ON items (tagged, seq)`).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_impact ON items (impact, direction)`).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_direction ON items (direction)`).run()
    // direction 的取值从 bull / bear 改名为 positive / negative（对新闻本身的读法，不是涨跌判断）：本地已经标过的库跟着改。幂等：改完就没有旧值可命中
    await this.db.prepare(`UPDATE items SET direction = CASE direction WHEN 'bull' THEN 'positive' ELSE 'negative' END WHERE direction IN ('bull', 'bear')`).run()
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS item_align (
        seq INTEGER NOT NULL,
        market TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        session TEXT NOT NULL,
        PRIMARY KEY (seq, market)
      ) WITHOUT ROWID
    `).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_item_align_date ON item_align (trade_date, market)`).run()
    // 题材（#2188 补充 S10）：按题材筛选走索引；items.themes（JSON 数组）是权威，这张表由它派生
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS item_themes (
        theme TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (theme, seq)
      ) WITHOUT ROWID
    `).run()
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_item_themes_seq ON item_themes (seq)`).run()
    // 这张表之前不存在：已经标过的库里 themes 有值而这里空，补一次（表里已经有数据就说明补过 / 在正常写入，不再动）。幂等
    if (!await this.db.prepare(`SELECT 1 AS x FROM item_themes LIMIT 1`).get()) {
      await this.db.prepare(`
        INSERT OR IGNORE INTO item_themes (theme, seq)
        SELECT j.value, i.seq FROM items i, json_each(i.themes) j WHERE i.tagged > 0 AND i.themes IS NOT NULL AND json_valid(i.themes) AND typeof(j.value) = 'text'
      `).run()
    }
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS item_deep (
        seq INTEGER PRIMARY KEY,
        result TEXT NOT NULL,
        model TEXT NOT NULL,
        basis TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        title_hash TEXT
      )
    `).run()
    await this.migrateDeepColumns()
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
   * items 表：#2184 的旧表没有 seq 与 feed_ts，也没有自增主键，这里重建一次（建新表、按首次出现的先后拷过去、换名）。
   * 每一步都能重跑：中途挂了，下次启动会接着做（items 不在而 items_v2 在，说明只差改名）。
   * 旧表里条目的 feed_ts 按同一条规则补出来，seq 按首次出现的先后顺序分配。
   */
  private async migrateItems() {
    const tables = new Set(rowsOf<{ name: string }>(await this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).map(r => r.name))
    if (!tables.has("items") && tables.has("items_v2")) {
      await this.db.prepare(`ALTER TABLE items_v2 RENAME TO items`).run()
    } else if (!tables.has("items")) {
      await this.db.prepare(ITEMS_DDL("items")).run()
    } else {
      const columns = rowsOf<{ name: string }>(await this.db.prepare(`PRAGMA table_info(items)`).all()).map(r => r.name)
      if (columns.includes("seq")) return
      await this.db.prepare(`DROP TABLE IF EXISTS items_v2`).run()
      await this.db.prepare(ITEMS_DDL("items_v2")).run()
      await this.db.prepare(`
        INSERT INTO items_v2 (source_id, item_id, title, url, pub_date, first_seen_at, last_seen_at, feed_ts)
        SELECT source_id, item_id, title, url, pub_date, first_seen_at, last_seen_at,
          CASE WHEN pub_date IS NOT NULL AND pub_date < first_seen_at THEN pub_date ELSE first_seen_at END
        FROM items ORDER BY first_seen_at, source_id, item_id
      `).run()
      await this.db.prepare(`DROP TABLE items`).run()
      await this.db.prepare(`ALTER TABLE items_v2 RENAME TO items`).run()
    }
  }

  /** 深读缓存加的列（版本、标题指纹）：旧表补上；老行 version = 0，不等于当前版本，会被当作没缓存重读。 */
  private async migrateDeepColumns() {
    const have = async () => new Set(rowsOf<{ name: string }>(await this.db.prepare(`PRAGMA table_info(item_deep)`).all()).map(r => r.name))
    let columns = await have()
    for (const [name, ddl] of [["version", "INTEGER NOT NULL DEFAULT 0"], ["title_hash", "TEXT"]] as const) {
      if (columns.has(name)) continue
      try {
        await this.db.prepare(`ALTER TABLE item_deep ADD COLUMN ${name} ${ddl}`).run()
      } catch (e) {
        columns = await have()
        if (!columns.has(name)) throw e
      }
    }
  }

  /**
   * 给已有的 items 表补富化的列。每列单独补、补之前先看有没有；两个进程同时首次迁移时后一个会撞上「duplicate column」，
   * 重新读一遍列确认已经有了就算成功（同样的并发问题 migrateItems 仍有，见 #2265 第 4 项，这里没有让它更糟）。
   */
  private async migrateEnrichColumns() {
    const have = async () => new Set(rowsOf<{ name: string }>(await this.db.prepare(`PRAGMA table_info(items)`).all()).map(r => r.name))
    let columns = await have()
    for (const [name, ddl] of ENRICH_COLUMNS) {
      if (columns.has(name)) continue
      try {
        await this.db.prepare(`ALTER TABLE items ADD COLUMN ${name} ${ddl}`).run()
      } catch (e) {
        columns = await have()
        if (!columns.has(name)) throw e
      }
    }
  }

  /**
   * 落一次采集：每条写 items（首次出现记 first_seen_at，之后只更新标题、链接、last_seen_at，发布时间有值才覆盖）
   * 与 observations（本次名次）。同一 (source, item, observedAt) 重复写入会被忽略，所以重试是幂等的。
   */
  async recordObservations(sourceId: string, rows: ObservedRow[], observedAt: number): Promise<IngestedItem[]> {
    const fresh = await this.serialized(async () => {
      // 已有的与新的分开写：对已有条目做 INSERT … ON CONFLICT DO UPDATE 也会耗掉一个 AUTOINCREMENT 值，
      // 而每个源每轮都会把榜上的老条目再写一遍，seq 会以「条目数 × 采集次数」的速度空涨，补发上限（feed/stream.ts）就失去意义。
      const existing = new Set<string>()
      const retitled: string[] = []
      for (const part of chunk(rows, EXISTS_IDS_PER_STATEMENT)) {
        const found = rowsOf<{ item_id: string, title: string }>(await this.db.prepare(`
          SELECT item_id, title FROM items WHERE source_id = ? AND item_id IN (${Array.from({ length: part.length }, () => "?").join(",")})
        `).all(sourceId, ...part.map(r => r.itemId)))
        const next = new Map(part.map(r => [r.itemId, r.title]))
        for (const f of found) {
          existing.add(f.item_id)
          if (next.get(f.item_id) !== f.title) retitled.push(f.item_id)
        }
      }
      for (const part of chunk(rows.filter(r => !existing.has(r.itemId)), ITEM_ROWS_PER_STATEMENT)) {
        const params = part.flatMap(r => [sourceId, r.itemId, r.title, r.url, r.pubDate, observedAt, observedAt, feedTimestamp(r.pubDate, observedAt)])
        // DO NOTHING：别的进程在查与写之间抢先写了同一条时不报错（那一条按它的写入为准）
        await this.db.prepare(`
          INSERT INTO items (source_id, item_id, title, url, pub_date, first_seen_at, last_seen_at, feed_ts)
          VALUES ${placeholders(ITEM_COLUMNS, part.length)}
          ON CONFLICT (source_id, item_id) DO NOTHING
        `).run(...params)
      }
      for (const part of chunk(rows.filter(r => existing.has(r.itemId)), UPDATE_ROWS_PER_STATEMENT)) {
        const params = part.flatMap(r => [r.itemId, r.title, r.url, r.pubDate])
        await this.db.prepare(`
          WITH v (item_id, title, url, pub_date) AS (VALUES ${placeholders(4, part.length)})
          UPDATE items SET
            title = v.title,
            url = COALESCE(v.url, items.url),
            pub_date = COALESCE(v.pub_date, items.pub_date),
            last_seen_at = ?
          FROM v WHERE items.source_id = ? AND items.item_id = v.item_id
        `).run(...params, observedAt, sourceId)
      }
      // 这一批里第一次出现的 = first_seen_at 等于本次 observedAt 的（走 idx_items_first_seen）。
      // 同一批重试会再取到同一批，seq 不变，客户端按 seq 去重。
      const items = rowsOf<Record<string, any>>(await this.db.prepare(`
        SELECT ${ITEM_SELECT} FROM items WHERE first_seen_at = ? AND source_id = ? ORDER BY seq
      `).all(observedAt, sourceId)).map(itemFromRow)
      if (retitled.length && this.enricher) {
        // 标题变了的老条目：清洗标题、标的、去重键跟着更新（主条目身份与分组不变）
        try {
          for (const part of chunk(retitled, EXISTS_IDS_PER_STATEMENT)) {
            const changed = rowsOf<Record<string, any>>(await this.db.prepare(`
              SELECT ${ITEM_SELECT} FROM items WHERE source_id = ? AND item_id IN (${Array.from({ length: part.length }, () => "?").join(",")})
            `).all(sourceId, ...part)).map(itemFromRow)
            await this.enricher.retitle(changed)
          }
        } catch (e) {
          logger.warn("enrich retitle failed", e)
        }
      }
      if (items.length && this.enricher) {
        // 富化与入库在同一个临界区里：组的主条目按 seq 先后定，通知出去的条目已带富化结果。失败不影响入库，条目留 enriched = 0 等回填。
        try {
          await this.enricher.enrich(items)
        } catch (e) {
          logger.warn("enrich failed", e)
        }
      }
      if (items.length) {
        for (const listener of [...this.listeners]) {
          try {
            listener(items)
          } catch (e) {
            logger.warn("ingest listener failed", e)
          }
        }
      }
      return items
    })
    for (const part of chunk(rows, OBSERVATION_ROWS_PER_STATEMENT)) {
      const params = part.flatMap(r => [sourceId, r.itemId, observedAt, r.rank, r.extra])
      await this.db.prepare(`
        INSERT OR IGNORE INTO observations (source_id, item_id, observed_at, rank, extra)
        VALUES ${placeholders(OBSERVATION_COLUMNS, part.length)}
      `).run(...params)
    }
    return fresh
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
