import type { Database } from "db0"
import type { IngestedItem, ItemEnricher } from "../collector/store"
import { cleanTitle } from "./clean"
import { FUZZY_WINDOW_MS, MIN_FUZZY_LENGTH, MIN_KEY_LENGTH, TITLE_WINDOW_MS, URL_WINDOW_MS, keyInfo, similar, titleKey } from "./dedup"
import type { KeyInfo } from "./dedup"
import { EnrichStore } from "./store"
import type { Candidate, EnrichedRow } from "./store"
import { extractSymbols } from "./symbols"
import { canonicalUrl } from "./url"

/**
 * 写库处的富化（#2188）：清洗标题、识别标的、去重分组。
 *
 * 分组规则（写死在这里，测试逐条覆盖）：
 * - 组的**主条目是组里入库最早的那条**（seq 最小）。「最早」指入库先后而不是发布时间：主条目一旦定下就不再变，信息流的游标、seq、SSE
 *   才不会因为后到的成员而漂；后到的成员只写自己的 dup_of，主条目那一行一个字节都不动，来源数是查询时按成员现算的。
 *   代价：某个慢轮询的源先采到了一条比别人晚发布的稿子，它就当主条目，哪怕别的源的版本发布得更早。
 * - 一条新条目与比它早入库的条目比：链接归一后相同（窗口 URL_WINDOW_MS），或标题键相同（TITLE_WINDOW_MS），或标题高度相似（FUZZY_WINDOW_MS，见 dedup.ts）。
 *   匹配到不止一个组时并入主条目 seq 最小的那个，**不合并两个已有的组**（主条目不动）。
 * - 同一个源里重复的也并（同一条快讯被源站重发），来源数按不同 source_id 算。
 * - 成员的 dup_of 永远直接指向主条目（没有链）。
 * - 富化失败（抛错）的条目留 enriched = 0，不影响入库；回填命令会按 seq 顺序补上，规则与实时一样。
 */

/** 富化规则的版本。改了规则要加一，回填的「重算标的」模式按它找旧的。 */
/**
 * 回填前要求库安静这么久：最近这么久内有采集写入就拒绝（--force 才跳过）。
 * 5 分钟：采集器每分钟一次心跳，各源按自己的间隔到期才抓（本沙箱 2026-11-22 的日志里 12 个源，每 1–2 分钟总有几个源到期）；
 * 取到最慢的常见间隔以上，免得源少时服务明明在跑却判成已停。没有更细的依据，待定。
 */
export const BACKFILL_QUIET_MS = 5 * 60_000

/** 库里最近一次采集写入在安静窗口之内：服务多半还在跑。 */
export const collectorLooksActive = (lastWriteAt: number, now: number) => now - lastWriteAt < BACKFILL_QUIET_MS

export const ENRICH_VERSION = 1

interface Working {
  item: IngestedItem
  clean: string
  origUrl: string | null
  canon: string | null
  key: string
  info: KeyInfo | undefined
  symbols: string[]
  dupOf: number | null
}

function compute(item: IngestedItem): Working {
  const cleaned = cleanTitle(item.title, item.url)
  const canon = canonicalUrl(cleaned.origUrl ?? item.url)
  const key = titleKey(cleaned.title)
  return {
    item,
    clean: cleaned.title,
    origUrl: cleaned.origUrl,
    canon,
    key,
    info: undefined,
    symbols: extractSymbols(cleaned.title),
    dupOf: null,
  }
}

export interface Enricher extends ItemEnricher {
  store: EnrichStore
  /** 只重算清洗标题与标的，不动分组（词典更新后用）。返回处理条数。 */
  resymbol: (batch?: number, onProgress?: (done: number) => void) => Promise<number>
  /** 已入库的条目标题变了（再次采到）：清洗标题、标的、去重键跟着重算；seq 与分组不动。 */
  retitle: (items: IngestedItem[]) => Promise<void>
  /** 给还没富化的历史条目补上（按 seq 顺序，规则与实时一样）。返回处理条数。 */
  backfill: (batch?: number, onProgress?: (done: number) => void) => Promise<number>
}

export function createEnricher(db: Database): Enricher {
  const store = new EnrichStore(db)
  /** 相似度比较里候选的二元组缓存：窗口内的候选每批都要比，不用每次重新切。 */
  const infoCache = new Map<number, KeyInfo>()
  const infoOf = (seq: number, key: string) => {
    let info = infoCache.get(seq)
    if (!info) {
      if (infoCache.size > 20_000) infoCache.clear()
      info = keyInfo(key)
      infoCache.set(seq, info)
    }
    return info
  }

  async function enrich(items: IngestedItem[]): Promise<void> {
    // 已富化的（重试同一批、回填重跑）只补标的
    const done = items.filter(i => i.enriched > 0)
    if (done.length) await store.hydrate(done)
    const todo = items.filter(i => i.enriched === 0).sort((a, b) => a.seq - b.seq)
    if (!todo.length) return
    const work = todo.map(compute)

    // ---- 候选：库里已富化的、比这批更早的条目；同批里先处理的条目随后加进内存索引
    const earliest = Math.min(...work.map(w => w.item.firstSeenAt))
    const urls = work.map(w => w.canon).filter((u): u is string => !!u)
    const keys = work.filter(w => w.key.length >= MIN_KEY_LENGTH).map(w => w.key)
    const byUrl = new Map<string, Candidate[]>()
    const byKey = new Map<string, Candidate[]>()
    const push = (map: Map<string, Candidate[]>, k: string, c: Candidate) => {
      const list = map.get(k)
      if (list) list.push(c)
      else map.set(k, [c])
    }
    for (const c of await store.findByCanonUrl(urls, earliest - URL_WINDOW_MS)) {
      if (c.canonUrl) push(byUrl, c.canonUrl, c)
    }
    for (const c of await store.findByTitleKey(keys, earliest - TITLE_WINDOW_MS)) {
      if (c.titleKey) push(byKey, c.titleKey, c)
    }
    let pool: Candidate[] | undefined
    const batchPool: Candidate[] = []

    const best = (cands: Candidate[] | undefined, w: Working, window: number): number | null => {
      let main: number | null = null
      for (const c of cands ?? []) {
        if (c.seq >= w.item.seq || c.firstSeenAt < w.item.firstSeenAt - window) continue
        if (main === null || c.mainSeq < main) main = c.mainSeq
      }
      return main
    }

    for (const w of work) {
      let main: number | null = null
      if (w.canon) main = best(byUrl.get(w.canon), w, URL_WINDOW_MS)
      if (w.key.length >= MIN_KEY_LENGTH) {
        const m = best(byKey.get(w.key), w, TITLE_WINDOW_MS)
        if (m !== null && (main === null || m < main)) main = m
      }
      if (main === null && w.key.length >= MIN_FUZZY_LENGTH) {
        pool ??= await store.recent(earliest - FUZZY_WINDOW_MS, MIN_FUZZY_LENGTH)
        w.info = keyInfo(w.key)
        for (const c of [...pool, ...batchPool]) {
          if (c.seq >= w.item.seq || !c.titleKey || c.firstSeenAt < w.item.firstSeenAt - FUZZY_WINDOW_MS) continue
          if (main !== null && c.mainSeq >= main) continue
          if (similar(w.info, infoOf(c.seq, c.titleKey))) main = c.mainSeq
        }
      }
      w.dupOf = main
      const self: Candidate = { seq: w.item.seq, mainSeq: main ?? w.item.seq, sourceId: w.item.sourceId, firstSeenAt: w.item.firstSeenAt, canonUrl: w.canon, titleKey: w.key }
      if (w.canon) push(byUrl, w.canon, self)
      if (w.key.length >= MIN_KEY_LENGTH) push(byKey, w.key, self)
      if (w.key.length >= MIN_FUZZY_LENGTH) batchPool.push(self)
    }

    const rows: EnrichedRow[] = work.map(w => ({
      seq: w.item.seq,
      cleanTitle: w.clean,
      origUrl: w.origUrl,
      canonUrl: w.canon,
      titleKey: w.key || null,
      dupOf: w.dupOf,
      symbols: w.symbols,
    }))
    await store.save(rows, ENRICH_VERSION)
    for (const w of work) {
      w.item.cleanTitle = w.clean
      w.item.origUrl = w.origUrl
      w.item.dupOf = w.dupOf
      w.item.symbols = w.symbols
      w.item.enriched = ENRICH_VERSION
    }
  }

  async function retitle(items: IngestedItem[]): Promise<void> {
    // 还没富化的（enriched = 0）留给回填，那时用的就是新标题
    const todo = items.filter(i => i.enriched > 0)
    if (!todo.length) return
    await store.saveSymbolsOnly(todo.map((item) => {
      const cleaned = cleanTitle(item.title, item.url)
      infoCache.delete(item.seq)
      return { seq: item.seq, cleanTitle: cleaned.title, origUrl: cleaned.origUrl, symbols: extractSymbols(cleaned.title), titleKey: titleKey(cleaned.title) || null }
    }))
  }

  async function backfill(batch = 200, onProgress?: (done: number) => void): Promise<number> {
    let after = 0
    let total = 0
    for (;;) {
      const items = await store.pending(after, batch)
      if (!items.length) return total
      await enrich(items)
      after = items.at(-1)!.seq
      total += items.length
      onProgress?.(total)
    }
  }

  async function resymbol(batch = 200, onProgress?: (done: number) => void): Promise<number> {
    let after = 0
    let total = 0
    for (;;) {
      const items = await store.scan(after, batch)
      if (!items.length) return total
      await store.saveSymbolsOnly(items.map((item) => {
        const cleaned = cleanTitle(item.title, item.url)
        return { seq: item.seq, cleanTitle: cleaned.title, origUrl: cleaned.origUrl, symbols: extractSymbols(cleaned.title) }
      }))
      after = items.at(-1)!.seq
      total += items.length
      onProgress?.(total)
    }
  }

  return { store, enrich, retitle, backfill, resymbol }
}
