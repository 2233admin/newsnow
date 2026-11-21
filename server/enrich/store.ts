import type { Database, Primitive } from "db0"
import { ITEM_SELECT, itemFromRow } from "../collector/store"
import type { IngestedItem } from "../collector/store"

/**
 * 富化的 SQL（#2188）：去重候选的查找、结果写回、标的与组的读取。只用 SQLite 与 D1 共有的语法；多行语句按 D1 的 100 个绑定参数上限分块，
 * 大列表用一个 JSON 参数 + json_each（同 feed/store.ts）。不用事务（D1 没有）：先写标的（幂等），最后才把 enriched 置位，
 * 中途挂了条目仍是 enriched = 0，回填会重做。
 */

const D1_MAX_PARAMS = 100
const SAVE_COLUMNS = 6
const SAVE_ROWS_PER_STATEMENT = Math.floor(D1_MAX_PARAMS / SAVE_COLUMNS)
const SYMBOL_ROWS_PER_STATEMENT = Math.floor(D1_MAX_PARAMS / 2)
const IN_PER_STATEMENT = D1_MAX_PARAMS - 2

/** 一个组最多把多少个成员的明细给出去；来源数是按全部成员算的。待定：前端一行展开看的量，没有实测。 */
export const MAX_MEMBERS_LISTED = 50

export interface Candidate {
  seq: number
  /** 它所在组的主条目 seq（自己是主条目就是自己的 seq） */
  mainSeq: number
  sourceId: string
  firstSeenAt: number
  canonUrl: string | null
  titleKey: string | null
}

export interface EnrichedRow {
  seq: number
  cleanTitle: string
  origUrl: string | null
  canonUrl: string | null
  titleKey: string | null
  dupOf: number | null
  symbols: string[]
}

export interface GroupMember {
  seq: number
  sourceId: string
  itemId: string
  url: string | null
  origUrl: string | null
  pubDate: number | null
  firstSeenAt: number
  feedTs: number
}

export interface GroupInfo {
  /** 全部成员（含主条目）里不同来源的个数 */
  sourcesCount: number
  /** 成员总数（含主条目） */
  size: number
  /** 主条目之外的成员，按 seq 升序，最多 MAX_MEMBERS_LISTED 个 */
  members: GroupMember[]
  /** 主条目本身（按来源收拢后，代表行可能是成员，要把主条目列进它的 members） */
  main: GroupMember
}

function rowsOf<T>(res: unknown): T[] {
  const rows = (res as { results?: unknown })?.results ?? res
  return Array.isArray(rows) ? rows as T[] : []
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const placeholders = (columns: number, rows: number) => Array.from({ length: rows }, () => `(${Array.from({ length: columns }, () => "?").join(",")})`).join(",")

function candidate(r: Record<string, any>): Candidate {
  return {
    seq: r.seq,
    mainSeq: r.dup_of ?? r.seq,
    sourceId: r.source_id,
    firstSeenAt: r.first_seen_at,
    canonUrl: r.canon_url ?? null,
    titleKey: r.title_key ?? null,
  }
}

const CANDIDATE_SELECT = `seq, dup_of, source_id, first_seen_at, canon_url, title_key`

export class EnrichStore {
  constructor(private db: Database) {}

  private async byKey(column: "canon_url" | "title_key", keys: string[], since: number): Promise<Candidate[]> {
    const out: Candidate[] = []
    for (const part of chunk([...new Set(keys)], IN_PER_STATEMENT)) {
      out.push(...rowsOf<Record<string, any>>(await this.db.prepare(`
        SELECT ${CANDIDATE_SELECT} FROM items
        WHERE ${column} IN (${part.map(() => "?").join(",")}) AND first_seen_at >= ? AND enriched > 0
      `).all(...part, since)).map(candidate))
    }
    return out
  }

  findByCanonUrl(urls: string[], since: number) {
    return this.byKey("canon_url", urls, since)
  }

  findByTitleKey(keys: string[], since: number) {
    return this.byKey("title_key", keys, since)
  }

  /** 相似度比较的候选池：窗口内、已富化、有足够长标题键的条目（只取到 before 这个 seq 之前的）。 */
  async recent(since: number, minKeyLength: number): Promise<Candidate[]> {
    return rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${CANDIDATE_SELECT} FROM items
      WHERE first_seen_at >= ? AND enriched > 0 AND title_key IS NOT NULL AND LENGTH(title_key) >= ?
    `).all(since, minKeyLength)).map(candidate)
  }

  /** 写回一批富化结果。先标的、后 items（见文件头）。 */
  async save(rows: EnrichedRow[], version: number) {
    for (const part of chunk(rows.flatMap(r => r.symbols.map(symbol => [symbol, r.seq] as const)), SYMBOL_ROWS_PER_STATEMENT)) {
      await this.db.prepare(`INSERT OR IGNORE INTO item_symbols (symbol, seq) VALUES ${placeholders(2, part.length)}`).run(...part.flat())
    }
    for (const part of chunk(rows, SAVE_ROWS_PER_STATEMENT)) {
      const params = part.flatMap(r => [r.seq, r.cleanTitle, r.origUrl, r.canonUrl, r.titleKey, r.dupOf] as Primitive[])
      await this.db.prepare(`
        WITH v (seq, clean_title, orig_url, canon_url, title_key, dup_of) AS (VALUES ${placeholders(SAVE_COLUMNS, part.length)})
        UPDATE items SET clean_title = v.clean_title, orig_url = v.orig_url, canon_url = v.canon_url, title_key = v.title_key,
          dup_of = COALESCE(items.dup_of, v.dup_of), enriched = ${Math.floor(version)}
        FROM v WHERE items.seq = v.seq
      `).run(...params)
    }
  }

  /** 只重算清洗标题与标的（词典更新后）：不动去重键与分组。 */
  async saveSymbolsOnly(rows: { seq: number, cleanTitle: string, origUrl: string | null, symbols: string[], titleKey?: string | null }[]) {
    for (const part of chunk(rows.map(r => r.seq), IN_PER_STATEMENT)) {
      await this.db.prepare(`DELETE FROM item_symbols WHERE seq IN (${part.map(() => "?").join(",")})`).run(...part)
    }
    for (const part of chunk(rows.flatMap(r => r.symbols.map(symbol => [symbol, r.seq] as const)), SYMBOL_ROWS_PER_STATEMENT)) {
      await this.db.prepare(`INSERT OR IGNORE INTO item_symbols (symbol, seq) VALUES ${placeholders(2, part.length)}`).run(...part.flat())
    }
    for (const part of chunk(rows, 32)) {
      // title_key 只在给了的时候更新（标题变了要跟着变；词典更新时不动去重键）
      await this.db.prepare(`
        WITH v (seq, clean_title, orig_url, set_key, title_key) AS (VALUES ${placeholders(5, part.length)})
        UPDATE items SET clean_title = v.clean_title, orig_url = v.orig_url,
          title_key = CASE WHEN v.set_key = 1 THEN v.title_key ELSE items.title_key END
        FROM v WHERE items.seq = v.seq
      `).run(...part.flatMap(r => [r.seq, r.cleanTitle, r.origUrl, r.titleKey === undefined ? 0 : 1, r.titleKey ?? null] as Primitive[]))
    }
  }

  /** 这些条目的标的。 */
  async symbolsOf(seqs: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>()
    if (!seqs.length) return out
    for (const part of chunk([...new Set(seqs)], 5000)) {
      for (const r of rowsOf<{ seq: number, symbol: string }>(await this.db.prepare(`
        SELECT seq, symbol FROM item_symbols WHERE seq IN (SELECT value FROM json_each(?)) ORDER BY seq, symbol
      `).all(JSON.stringify(part)))) {
        const list = out.get(r.seq)
        if (list) list.push(r.symbol)
        else out.set(r.seq, [r.symbol])
      }
    }
    return out
  }

  /** 给条目补上标的（原地）。 */
  async hydrate(items: IngestedItem[]): Promise<void> {
    const symbols = await this.symbolsOf(items.map(i => i.seq))
    for (const item of items) item.symbols = symbols.get(item.seq) ?? []
  }

  /**
   * 这些组（按主条目 seq）的成员与来源数。组内成员按 seq 升序。
   * 来源数 = 主条目与所有成员里不同 source_id 的个数。
   */
  async groups(mainSeqs: number[]): Promise<Map<number, GroupInfo>> {
    const out = new Map<number, GroupInfo>()
    const ids = [...new Set(mainSeqs)]
    if (!ids.length) return out
    const json = JSON.stringify(ids)
    const sources = new Map<number, Set<string>>()
    for (const r of rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT seq, source_id, item_id, url, orig_url, pub_date, first_seen_at, feed_ts FROM items WHERE seq IN (SELECT value FROM json_each(?))
    `).all(json))) {
      sources.set(r.seq, new Set([r.source_id]))
      out.set(r.seq, {
        sourcesCount: 1,
        size: 1,
        members: [],
        main: { seq: r.seq, sourceId: r.source_id, itemId: r.item_id, url: r.url, origUrl: r.orig_url, pubDate: r.pub_date, firstSeenAt: r.first_seen_at, feedTs: r.feed_ts },
      })
    }
    const rows = rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT seq, dup_of, source_id, item_id, url, orig_url, pub_date, first_seen_at, feed_ts FROM items
      WHERE dup_of IN (SELECT value FROM json_each(?)) ORDER BY seq
    `).all(json))
    for (const r of rows) {
      const info = out.get(r.dup_of)
      if (!info) continue
      sources.get(r.dup_of)!.add(r.source_id)
      info.size++
      if (info.members.length < MAX_MEMBERS_LISTED) {
        info.members.push({ seq: r.seq, sourceId: r.source_id, itemId: r.item_id, url: r.url, origUrl: r.orig_url, pubDate: r.pub_date, firstSeenAt: r.first_seen_at, feedTs: r.feed_ts })
      }
    }
    for (const [seq, info] of out) info.sourcesCount = sources.get(seq)!.size
    return out
  }

  /** 还没富化的条目，按 seq 升序（回填用）。 */
  async pending(afterSeq: number, limit: number): Promise<IngestedItem[]> {
    return rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${ITEM_SELECT} FROM items WHERE enriched = 0 AND seq > ? ORDER BY seq LIMIT ?
    `).all(afterSeq, limit)).map(itemFromRow)
  }

  /** 全部条目按 seq 升序（只重算标的时用）。 */
  async scan(afterSeq: number, limit: number): Promise<IngestedItem[]> {
    return rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${ITEM_SELECT} FROM items WHERE seq > ? ORDER BY seq LIMIT ?
    `).all(afterSeq, limit)).map(itemFromRow)
  }

  /**
   * 采集最近一次写库的时间（毫秒）：source_health 的最近尝试与 items 的最近看到取大者；没有记录是 0。
   * 回填脚本用它判断服务是不是还在采集（见 BACKFILL_QUIET_MS）。
   */
  async lastCollectorWriteAt(): Promise<number> {
    const health = await this.db.prepare(`SELECT MAX(last_attempt_at) AS t FROM source_health`).get() as { t: number | null } | undefined
    const items = await this.db.prepare(`SELECT MAX(last_seen_at) AS t FROM items`).get() as { t: number | null } | undefined
    return Math.max(health?.t ?? 0, items?.t ?? 0)
  }

  async counts(): Promise<{ total: number, pending: number }> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN enriched = 0 THEN 1 ELSE 0 END) AS pending FROM items`).get() as { total: number, pending: number | null }
    return { total: row.total, pending: row.pending ?? 0 }
  }
}
