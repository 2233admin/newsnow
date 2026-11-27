import { appendFileSync } from "node:fs"
import process from "node:process"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { describe, expect, it } from "vitest"
import { T0, descriptors, feedWorld, ingest, row } from "../feed/helpers"
import { createFeedService } from "#/feed/service"
import { FeedStore } from "#/feed/store"
import { ObservationStore } from "#/collector/store"

// #9 复审：标的条件写成 COALESCE(dup_of, seq) IN (…) 用不上索引，罕见标的的查询在 30 万行上从 3 ms 退到 88 ms。
describe("成员的 dup_of 直接指向主条目、不成链（标的查询的 dup_of ∈ G 依赖它）", () => {
  it("两组并成一组、同批重复、同源重发之后，没有指向成员的 dup_of", async () => {
    const w = await feedWorld(descriptors(), { enrich: true })
    const T = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
    await ingest(w, "jin10", [row("a", { title: T, url: "https://a.example/1" }), row("a2", { title: T, url: "https://a.example/2" })], T0)
    await ingest(w, "weibo", [row("b", { title: `${T}。`, url: "https://a.example/3" })], T0 + 1000)
    await ingest(w, "hackernews", [row("c", { title: "完全无关的另一条新闻内容，用来造第二个组的主条目", url: "https://b.example/1" })], T0 + 2000)
    await ingest(w, "weibo", [row("d", { title: "完全无关的另一条新闻内容，用来造第二个组的主条目", url: "https://a.example/1?utm_source=x" })], T0 + 3000)
    const chained = await w.db.prepare("SELECT COUNT(*) AS n FROM items m JOIN items p ON p.seq = m.dup_of WHERE p.dup_of IS NOT NULL").get() as { n: number }
    expect(chained.n).toBe(0)
    const members = await w.db.prepare("SELECT COUNT(*) AS n FROM items WHERE dup_of IS NOT NULL").get() as { n: number }
    expect(members.n).toBeGreaterThan(0)
  })
})

describe("合成大库上按标的查询的耗时有上限", () => {
  const ROWS = 200_000
  /**
   * 每类查询 20 次的 p95 上限（毫秒）。依据：#9 审阅在 30 万行合成库上量的，索引写法 p95 3–12 ms，COALESCE 写法 48–115 ms；
   *  30 ms 在两者之间，留给 CI 机器 2.5 倍以上的余量。待定：数字没有按 CI 实测调过。
   */
  const P95_MS = 30

  it("罕见标的、不存在的标的、标的加来源，p95 不超过上限", async () => {
    const db = createDatabase(sqlite({ name: ":memory:" }))
    const store = new ObservationStore(db)
    await store.init()
    // 一批 SQL 造数：i 从 1 起，seq = i；每 7 条里第 7 条是前一条的成员（dup_of 指向主条目，不成链）
    await db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
      INSERT INTO items (source_id, item_id, title, url, pub_date, first_seen_at, last_seen_at, feed_ts, clean_title, dup_of, enriched)
      SELECT CASE WHEN i % 2 = 0 THEN 'jin10' ELSE 'hackernews' END, 'id' || i, '测试快讯 ' || i, NULL, NULL,
        ${T0} + i * 1000, ${T0} + i * 1000, ${T0} + i * 1000, '测试快讯 ' || i, CASE WHEN i % 7 = 0 THEN i - 1 END, 1 FROM n
    `)
    await db.exec(`INSERT INTO item_symbols (symbol, seq) SELECT 'NVDA.XNAS', seq FROM items WHERE seq % 100 = 3`)
    await db.exec(`INSERT INTO item_symbols (symbol, seq) SELECT 'RARE.XNAS', seq FROM items WHERE seq IN (5, 20007)`)
    await db.exec(`ANALYZE`)
    const service = createFeedService({ store: new FeedStore(db), describe: async () => descriptors(), clock: () => T0 })
    const cases: [string, Record<string, unknown>, number][] = [
      ["罕见标的", { symbol: "RARE.XNAS" }, 2],
      ["不存在的标的", { symbol: "NONE.XNAS" }, 0],
      ["罕见标的 + 来源", { symbol: "RARE.XNAS", source: "hackernews" }, 2],
      ["常见标的 200 条", { symbol: "NVDA.XNAS", limit: "200" }, 200],
    ]
    for (const [label, params, rows] of cases) {
      const first = await service.query(params)
      expect(first.items.length, label).toBe(rows)
      const times: number[] = []
      for (let i = 0; i < 20; i++) {
        const t = performance.now()
        await service.query(params)
        times.push(performance.now() - t)
      }
      times.sort((a, b) => a - b)
      if (process.env.PERF_REPORT) appendFileSync(process.env.PERF_REPORT, `${label} p50 ${times[10].toFixed(1)} p95 ${times[18].toFixed(1)}\n`)
      expect(times[18], `${label} p95 ${times[18].toFixed(1)} ms`).toBeLessThan(P95_MS)
    }
  }, 60_000)
})

// #2188 补充：对齐交易日、影响类型 / 方向、过滤原因进了查询条件，大库上也要在上限之内。
describe("合成大库上按对齐 / 标注 / 过滤查询的耗时有上限", () => {
  const ROWS = 200_000
  /** 与上面标的查询同一个上限与依据（待定，没有按 CI 实测调过）。 */
  const P95_MS = 30

  it("默认首屏（过滤成了范围条件）、tradeDate（新旧两天）、罕见 / 常见影响类型、影响类型 + 方向、includeFiltered", async () => {
    const db = createDatabase(sqlite({ name: ":memory:" }))
    const store = new ObservationStore(db)
    await store.init()
    await db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
      INSERT INTO items (source_id, item_id, title, url, pub_date, first_seen_at, last_seen_at, feed_ts, clean_title, dup_of, enriched, filter_reason)
      SELECT CASE WHEN i % 2 = 0 THEN 'jin10' ELSE 'hackernews' END, 'id' || i, '测试快讯 ' || i, NULL, NULL,
        ${T0} + i * 17000, ${T0} + i * 17000, ${T0} + i * 17000, '测试快讯 ' || i, CASE WHEN i % 7 = 0 THEN i - 1 END, 2,
        CASE WHEN i % 50 = 1 THEN 'ranking_list' END FROM n
    `)
    // 每条对齐到它所在的 UTC 日（17 秒一条，20 万条跨 39 天，每天约 5000 条，比真实采集的日入库量还高）
    await db.exec(`INSERT INTO item_align (seq, market, trade_date, session) SELECT seq, 'cn', strftime('%Y-%m-%d', feed_ts / 1000, 'unixepoch'), 'open' FROM items`)
    await db.exec(`
      UPDATE items SET tagged = 1,
        impact = CASE seq % 5 WHEN 0 THEN '公告' WHEN 1 THEN '政策与监管' WHEN 2 THEN '行业与题材' WHEN 3 THEN '公司经营' ELSE '市场情绪' END,
        direction = CASE seq % 3 WHEN 0 THEN 'positive' WHEN 1 THEN 'negative' ELSE 'neutral' END
      WHERE dup_of IS NULL
    `)
    await db.exec(`UPDATE items SET impact = '稀有类型' WHERE seq IN (5, 20007)`)
    await db.exec(`ANALYZE`)
    const service = createFeedService({ store: new FeedStore(db), describe: async () => descriptors(), clock: () => T0 })
    const first = new Date(T0 + 17_000).toISOString().slice(0, 10)
    const last = new Date(T0 + ROWS * 17_000).toISOString().slice(0, 10)
    expect(first).not.toBe(last)
    // 第四项是这一类的 p95 上限（毫秒），不写就是 P95_MS。最后一类是最坏的组合（最早一天 + 常见类型 + 来源）：窗口凑不够页，落到整查询，
    // 要在 20 万行里先建「常见类型」的集合再与那一天求交；实测 p95 24–36 ms，上限放宽到 60，待定（没有按 CI 实测调过）。
    const cases: [string, Record<string, unknown>, number, number?][] = [
      ["默认首屏", {}, 50],
      ["默认首屏 200 条", { limit: "200" }, 200],
      ["含过滤的首屏", { includeFiltered: "1" }, 50],
      ["tradeDate 最新一天", { market: "cn", tradeDate: last }, 50],
      ["tradeDate 最早一天", { market: "cn", tradeDate: first }, 50],
      ["tradeDate 不存在的一天", { market: "cn", tradeDate: "2020-01-01" }, 0],
      ["罕见影响类型", { impact: "稀有类型" }, 2],
      ["常见影响类型", { impact: "公告" }, 50],
      ["影响类型 + 方向", { impact: "公告", direction: "positive" }, 50],
      ["只有方向", { direction: "negative" }, 50],
      ["影响类型 + 最早一天 + 来源（最坏组合）", { impact: "公告", market: "cn", tradeDate: first, source: "jin10" }, 50, 60],
    ]
    for (const [label, params, rows, limitMs] of cases) {
      const res = await service.query(params)
      expect(res.items.length, label).toBe(rows)
      const times: number[] = []
      for (let i = 0; i < 20; i++) {
        const t = performance.now()
        await service.query(params)
        times.push(performance.now() - t)
      }
      times.sort((a, b) => a - b)
      if (process.env.PERF_REPORT) appendFileSync(process.env.PERF_REPORT, `${label} p50 ${times[10].toFixed(1)} p95 ${times[18].toFixed(1)}\n`)
      expect(times[18], `${label} p95 ${times[18].toFixed(1)} ms`).toBeLessThan(limitMs ?? P95_MS)
    }
  }, 120_000)
})
