import type { Database, Primitive } from "db0"
import { ITEM_SELECT, itemFromRow, tagsFromRow } from "../collector/store"
import type { IngestedItem } from "../collector/store"
import type { Align, Direction, FilterReason, ItemTags } from "./types"

/**
 * 富化的 SQL（#2188）：去重候选的查找、结果写回、标的与组的读取。只用 SQLite 与 D1 共有的语法；多行语句按 D1 的 100 个绑定参数上限分块，
 * 大列表用一个 JSON 参数 + json_each（同 feed/store.ts）。不用事务（D1 没有）：先写标的（幂等），最后才把 enriched 置位，
 * 中途挂了条目仍是 enriched = 0，回填会重做。
 */

const D1_MAX_PARAMS = 100
const SAVE_COLUMNS = 7
/** 对齐按 JSON 数组一次传多少行（一个绑定参数，约 50 字节一行）。待定：只是让单个参数不至于很大。 */
const ALIGN_ROWS_PER_JSON = 500
const TAG_COLUMNS = 5
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
  /** 规则层的过滤原因 */
  filterReason: FilterReason | null
  align: Align[]
}

/** 只重算规则层与对齐（标的变了、日历改了）：不动分组。 */
export interface RuleRow {
  seq: number
  filterReason: FilterReason | null
  align: Align[]
}

export interface TagRow {
  seq: number
  impact: string | null
  direction: Direction | null
  gist: string | null
  themes: string[] | null
}

export interface DeepRecord {
  seq: number
  /** 深读结果的 JSON 文本 */
  result: string
  model: string
  /** 依据的材料：page = 抓到了原文页面，title = 只有标题（及同组的其他报道标题） */
  basis: string
  createdAt: number
  /** 生成它的提示词 / 字段版本（deep.ts 的 DEEP_VERSION）；版本不同的缓存不算命中 */
  version: number
  /** 生成它时标题的指纹；标题变了（retitle）指纹对不上，缓存不算命中。老数据没有是 null */
  titleHash: string | null
}

/** 待标注的一组：groupId 是主条目的 seq（结果记在它上面），item 是标题发给模型的那一条（通常就是主条目）。 */
export interface PendingTag {
  groupId: number
  item: IngestedItem
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
  /** 组的标注（挂在主条目上；主条目被规则层过滤时按组里第一个没被过滤的成员的标题标，见 pendingTags）；没标过是 null */
  tags: ItemTags | null
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

  /** 写回一批富化结果。先标的与对齐、后 items（见文件头）。 */
  async save(rows: EnrichedRow[], version: number) {
    for (const part of chunk(rows.flatMap(r => r.symbols.map(symbol => [symbol, r.seq] as const)), SYMBOL_ROWS_PER_STATEMENT)) {
      await this.db.prepare(`INSERT OR IGNORE INTO item_symbols (symbol, seq) VALUES ${placeholders(2, part.length)}`).run(...part.flat())
    }
    await this.saveAlign(rows)
    for (const part of chunk(rows, SAVE_ROWS_PER_STATEMENT)) {
      const params = part.flatMap(r => [r.seq, r.cleanTitle, r.origUrl, r.canonUrl, r.titleKey, r.dupOf, r.filterReason] as Primitive[])
      await this.db.prepare(`
        WITH v (seq, clean_title, orig_url, canon_url, title_key, dup_of, filter_reason) AS (VALUES ${placeholders(SAVE_COLUMNS, part.length)})
        UPDATE items SET clean_title = v.clean_title, orig_url = v.orig_url, canon_url = v.canon_url, title_key = v.title_key,
          dup_of = COALESCE(items.dup_of, v.dup_of), filter_reason = v.filter_reason, enriched = ${Math.floor(version)}
        FROM v WHERE items.seq = v.seq
      `).run(...params)
    }
  }

  /**
   * 重写这些条目的对齐（日历改了、标的变了，市场的个数可能变）。幂等，且服务在跑时读的人不会读到「刚删完还没插」的空窗：
   * 先 upsert 新的（一条语句，要么全进要么全不进），再删掉这些条目里不在新结果里的市场行（另一条语句）；D1 没有事务，所以不用「先删后插」。
   * 两条语句之间进程挂了，最多留着多余的旧市场行（标的变少、涉及的市场变少时才有），重跑一遍（`enrich:backfill --rules --all`）即清掉；
   * 数据一直是「旧的完整」或「新的完整」或「新的 + 多余的旧市场行」，不会缺行。
   * 参数用 JSON 数组 + json_each 传（同 feed/store.ts），一条语句的绑定参数个数固定，D1 的 100 个上限不是问题。
   */
  async saveAlign(rows: { seq: number, align: Align[] }[]) {
    for (const part of chunk(rows.flatMap(r => r.align.map(a => [r.seq, a.market, a.tradeDate, a.session] as const)), ALIGN_ROWS_PER_JSON)) {
      await this.db.prepare(`
        INSERT INTO item_align (seq, market, trade_date, session)
        SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), json_extract(j.value, '$[3]') FROM json_each(?) j WHERE true
        ON CONFLICT (seq, market) DO UPDATE SET trade_date = excluded.trade_date, session = excluded.session
      `).run(JSON.stringify(part))
    }
    for (const part of chunk(rows, ALIGN_ROWS_PER_JSON)) {
      await this.db.prepare(`
        DELETE FROM item_align WHERE seq IN (SELECT value FROM json_each(?)) AND (seq || ':' || market) NOT IN (SELECT value FROM json_each(?))
      `).run(JSON.stringify(part.map(r => r.seq)), JSON.stringify(part.flatMap(r => r.align.map(a => `${r.seq}:${a.market}`))))
    }
  }

  /** 只更新规则层结果与对齐，并把 enriched 置为 version（分组、标题、标的都不动）。 */
  async saveRules(rows: RuleRow[], version: number) {
    await this.saveAlign(rows)
    for (const part of chunk(rows, Math.floor(D1_MAX_PARAMS / 2))) {
      await this.db.prepare(`
        WITH v (seq, filter_reason) AS (VALUES ${placeholders(2, part.length)})
        UPDATE items SET filter_reason = v.filter_reason, enriched = MAX(items.enriched, ${Math.floor(version)})
        FROM v WHERE items.seq = v.seq
      `).run(...part.flatMap(r => [r.seq, r.filterReason] as Primitive[]))
    }
  }

  /** 已富化、但富化版本低于 version 的条目（给规则层 / 对齐补算用），按 seq 升序；all 为真时不看版本。 */
  async rulesPending(afterSeq: number, limit: number, version: number, all: boolean): Promise<IngestedItem[]> {
    return rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${ITEM_SELECT} FROM items WHERE enriched > 0 AND (? = 1 OR enriched < ?) AND seq > ? ORDER BY seq LIMIT ?
    `).all(all ? 1 : 0, version, afterSeq, limit)).map(itemFromRow)
  }

  /** 只重算清洗标题与标的（词典更新后）：不动去重键与分组。 */
  async saveSymbolsOnly(rows: { seq: number, cleanTitle: string, origUrl: string | null, symbols: string[], titleKey?: string | null, filterReason?: FilterReason | null, align?: Align[] }[]) {
    for (const part of chunk(rows.map(r => r.seq), IN_PER_STATEMENT)) {
      await this.db.prepare(`DELETE FROM item_symbols WHERE seq IN (${part.map(() => "?").join(",")})`).run(...part)
    }
    for (const part of chunk(rows.flatMap(r => r.symbols.map(symbol => [symbol, r.seq] as const)), SYMBOL_ROWS_PER_STATEMENT)) {
      await this.db.prepare(`INSERT OR IGNORE INTO item_symbols (symbol, seq) VALUES ${placeholders(2, part.length)}`).run(...part.flat())
    }
    for (const part of chunk(rows, Math.floor(D1_MAX_PARAMS / 7))) {
      // title_key 只在给了的时候更新（标题变了要跟着变；词典更新时不动去重键）
      await this.db.prepare(`
        WITH v (seq, clean_title, orig_url, set_key, title_key, set_rules, filter_reason) AS (VALUES ${placeholders(7, part.length)})
        UPDATE items SET clean_title = v.clean_title, orig_url = v.orig_url,
          title_key = CASE WHEN v.set_key = 1 THEN v.title_key ELSE items.title_key END,
          filter_reason = CASE WHEN v.set_rules = 1 THEN v.filter_reason ELSE items.filter_reason END
        FROM v WHERE items.seq = v.seq
      `).run(...part.flatMap(r => [r.seq, r.cleanTitle, r.origUrl, r.titleKey === undefined ? 0 : 1, r.titleKey ?? null, r.filterReason === undefined ? 0 : 1, r.filterReason ?? null] as Primitive[]))
    }
    // 标的变了，涉及的市场可能跟着变：给了对齐的一并重写
    await this.saveAlign(rows.filter((r): r is typeof r & { align: Align[] } => r.align !== undefined))
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

  /** 这些条目的对齐交易日，每条按市场 cn、us、crypto 的顺序。 */
  async alignOf(seqs: number[]): Promise<Map<number, Align[]>> {
    const out = new Map<number, Align[]>()
    if (!seqs.length) return out
    for (const part of chunk([...new Set(seqs)], 5000)) {
      for (const r of rowsOf<{ seq: number, market: Align["market"], trade_date: string, session: Align["session"] }>(await this.db.prepare(`
        SELECT seq, market, trade_date, session FROM item_align WHERE seq IN (SELECT value FROM json_each(?))
        ORDER BY seq, CASE market WHEN 'cn' THEN 0 WHEN 'us' THEN 1 ELSE 2 END
      `).all(JSON.stringify(part)))) {
        const list = out.get(r.seq)
        const a: Align = { market: r.market, tradeDate: r.trade_date, session: r.session }
        if (list) list.push(a)
        else out.set(r.seq, [a])
      }
    }
    return out
  }

  /** 给条目补上标的与对齐（原地）。 */
  async hydrate(items: IngestedItem[]): Promise<void> {
    const seqs = items.map(i => i.seq)
    const [symbols, align] = await Promise.all([this.symbolsOf(seqs), this.alignOf(seqs)])
    for (const item of items) {
      item.symbols = symbols.get(item.seq) ?? []
      item.align = align.get(item.seq) ?? []
    }
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
      SELECT seq, source_id, item_id, url, orig_url, pub_date, first_seen_at, feed_ts, impact, direction, gist, themes, tagged FROM items WHERE seq IN (SELECT value FROM json_each(?))
    `).all(json))) {
      sources.set(r.seq, new Set([r.source_id]))
      out.set(r.seq, {
        sourcesCount: 1,
        size: 1,
        members: [],
        tags: tagsFromRow(r),
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

  // ---- 批量标注层

  /**
   * 待标注的组（按主条目 seq）：主条目已富化、还没标过、失败次数没到上限；新的先标（新闻的价值随时间衰减）。
   * 标注的来源（标题发给模型的那一条）：主条目没被规则层过滤就是它；被过滤了（比如主条目是软文）就取组里第一个没被过滤的成员，
   * 这样一个正常的转载不会因为主条目被过滤而整组永远没有标注；整组都被过滤的不标。结果与失败计数都记在主条目上（groupId），
   * 所以读取与筛选照旧按主条目判断。sourceIds 不为 null 时只看来源在其中、或标题里识别出了标的的来源条目（财经之外的源里偶尔也有财经消息）。
   */
  async pendingTags(limit: number, maxAttempts: number, sourceIds: string[] | null): Promise<PendingTag[]> {
    const scope = sourceIds === null ? "" : `AND (s.source_id IN (SELECT value FROM json_each(?)) OR s.seq IN (SELECT seq FROM item_symbols))`
    const cols = ITEM_SELECT.split(",").map(c => `s.${c.trim()}`).join(", ")
    const rows = rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT ${cols}, m.seq AS group_id FROM items m
      JOIN items s ON s.seq = CASE WHEN m.filter_reason IS NULL THEN m.seq ELSE (SELECT MIN(x.seq) FROM items x WHERE x.dup_of = m.seq AND x.filter_reason IS NULL) END
      WHERE m.tagged = 0 AND m.dup_of IS NULL AND m.enriched > 0 AND m.tag_attempts < ? AND s.enriched > 0 ${scope}
      ORDER BY m.seq DESC LIMIT ?
    `).all(...[maxAttempts, ...(sourceIds === null ? [] : [JSON.stringify(sourceIds)]), limit]))
    const items = rows.map(itemFromRow)
    await this.hydrate(items)
    return items.map((item, i) => ({ groupId: rows[i].group_id as number, item }))
  }

  /** 写回一批标注结果，并把 tagged 置为 version。 */
  async saveTags(rows: TagRow[], version: number) {
    for (const part of chunk(rows, Math.floor(D1_MAX_PARAMS / TAG_COLUMNS))) {
      await this.db.prepare(`
        WITH v (seq, impact, direction, gist, themes) AS (VALUES ${placeholders(TAG_COLUMNS, part.length)})
        UPDATE items SET impact = v.impact, direction = v.direction, gist = v.gist, themes = v.themes, tagged = ${Math.floor(version)}
        FROM v WHERE items.seq = v.seq
      `).run(...part.flatMap(r => [r.seq, r.impact, r.direction, r.gist, r.themes ? JSON.stringify(r.themes) : null] as Primitive[]))
    }
    // 题材另存一份 item_themes（theme, seq），给按题材筛选走索引；items.themes 是权威，这张表由它派生（init 时也会补）
    await this.clearThemes(rows.map(r => r.seq))
    for (const part of chunk(rows.flatMap(r => [...new Set(r.themes ?? [])].map(theme => [theme, r.seq] as const)), SYMBOL_ROWS_PER_STATEMENT)) {
      await this.db.prepare(`INSERT OR IGNORE INTO item_themes (theme, seq) VALUES ${placeholders(2, part.length)}`).run(...part.flat())
    }
  }

  private async clearThemes(seqs: number[]) {
    for (const part of chunk([...new Set(seqs)], IN_PER_STATEMENT)) {
      await this.db.prepare(`DELETE FROM item_themes WHERE seq IN (${part.map(() => "?").join(",")})`).run(...part)
    }
  }

  /** 这些条目标注失败一次（模型没返回它、或返回的整条不可用）：计数加一，到上限就不再自动重试。 */
  async bumpTagAttempts(seqs: number[]) {
    for (const part of chunk(seqs, IN_PER_STATEMENT)) {
      await this.db.prepare(`UPDATE items SET tag_attempts = tag_attempts + 1 WHERE seq IN (${part.map(() => "?").join(",")})`).run(...part)
    }
  }

  /**
   * 这些条目的标题变了：它们若是所在组的标注来源（自己是主条目，或主条目被规则层过滤、标注是按成员的标题打的），清掉那一组（主条目）的标注与失败计数，
   * 回到待标注，按新标题重标。没标过也没失败过的不动；不是标注来源的成员改标题不影响标注。
   */
  async resetTagsForRetitled(seqs: number[]) {
    for (const part of chunk([...new Set(seqs)], IN_PER_STATEMENT)) {
      const ids = part.map(() => "?").join(",")
      await this.db.prepare(`DELETE FROM item_themes WHERE seq IN (${this.retitledGroups(ids)})`).run(...part)
      await this.db.prepare(`
        UPDATE items SET impact = NULL, direction = NULL, gist = NULL, themes = NULL, tagged = 0, tag_attempts = 0
        WHERE (tagged > 0 OR tag_attempts > 0) AND seq IN (${this.retitledGroups(ids)})
      `).run(...part)
    }
  }

  private retitledGroups(ids: string) {
    return `SELECT COALESCE(x.dup_of, x.seq) FROM items x WHERE x.seq IN (${ids})
      AND (x.dup_of IS NULL OR EXISTS (SELECT 1 FROM items g WHERE g.seq = x.dup_of AND g.filter_reason IS NOT NULL))`
  }

  /** 只把「失败到上限、一直没标成」的组的失败计数清零，回到待标注（已标好的不动，不重付费）。返回清掉的组数。 */
  async resetFailedTags(maxAttempts: number): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE tagged = 0 AND tag_attempts >= ?`).get(maxAttempts) as { n: number }
    await this.db.prepare(`UPDATE items SET tag_attempts = 0 WHERE tagged = 0 AND tag_attempts >= ?`).run(maxAttempts)
    return row.n
  }

  /** 清掉标注，让它们回到待标注（改了分类表之后重标）。返回清掉的组数。 */
  async resetTags(): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE tagged > 0 OR tag_attempts > 0`).get() as { n: number }
    await this.db.prepare(`UPDATE items SET impact = NULL, direction = NULL, gist = NULL, themes = NULL, tagged = 0, tag_attempts = 0 WHERE tagged > 0 OR tag_attempts > 0`).run()
    await this.db.prepare(`DELETE FROM item_themes`).run()
    return row.n
  }

  async tagCounts(maxAttempts: number): Promise<{ tagged: number, pending: number, gaveUp: number }> {
    // 待标注 / 放弃：主条目没标过、已富化，且有可当标注来源的条目（主条目自己没被过滤，或组里有没被过滤的成员）
    const eligible = `tagged = 0 AND dup_of IS NULL AND enriched > 0 AND (filter_reason IS NULL OR EXISTS (SELECT 1 FROM items x WHERE x.dup_of = items.seq AND x.filter_reason IS NULL))`
    const row = await this.db.prepare(`
      SELECT SUM(CASE WHEN tagged > 0 THEN 1 ELSE 0 END) AS tagged,
        SUM(CASE WHEN ${eligible} AND tag_attempts < ? THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN ${eligible} AND tag_attempts >= ? THEN 1 ELSE 0 END) AS gave_up
      FROM items
    `).get(maxAttempts, maxAttempts) as { tagged: number | null, pending: number | null, gave_up: number | null }
    return { tagged: row.tagged ?? 0, pending: row.pending ?? 0, gaveUp: row.gave_up ?? 0 }
  }

  // ---- 按需深读层

  async item(seq: number): Promise<IngestedItem | undefined> {
    const items = rowsOf<Record<string, any>>(await this.db.prepare(`SELECT ${ITEM_SELECT} FROM items WHERE seq = ?`).all(seq)).map(itemFromRow)
    await this.hydrate(items)
    return items[0]
  }

  async getDeep(seq: number): Promise<DeepRecord | undefined> {
    const r = await this.db.prepare(`SELECT seq, result, model, basis, created_at, version, title_hash FROM item_deep WHERE seq = ?`).get(seq) as Record<string, any> | undefined
    return r ? { seq: r.seq, result: r.result, model: r.model, basis: r.basis, createdAt: r.created_at, version: r.version ?? 0, titleHash: r.title_hash ?? null } : undefined
  }

  async saveDeep(rec: DeepRecord) {
    await this.db.prepare(`INSERT OR REPLACE INTO item_deep (seq, result, model, basis, created_at, version, title_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(rec.seq, rec.result, rec.model, rec.basis, rec.createdAt, rec.version, rec.titleHash)
  }

  async counts(): Promise<{ total: number, pending: number }> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN enriched = 0 THEN 1 ELSE 0 END) AS pending FROM items`).get() as { total: number, pending: number | null }
    return { total: row.total, pending: row.pending ?? 0 }
  }
}
