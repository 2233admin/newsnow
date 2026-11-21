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
