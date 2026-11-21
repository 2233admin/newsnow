import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { describe, expect, it, vi } from "vitest"
import { T0, feedWorld, ingest, row } from "./helpers"
import { ObservationStore } from "#/collector/store"
import type { IngestedItem } from "#/collector/store"

describe("入库时的新条目通知（SSE 的来源）", () => {
  it("只通知第一次出现的条目；重复采集不通知；返回值与通知一致", async () => {
    const w = await feedWorld()
    const got: IngestedItem[][] = []
    w.store.onIngest(items => got.push(items))
    const first = await ingest(w, "jin10", [row("a"), row("b")], T0)
    expect(first.map(i => [i.itemId, i.seq])).toEqual([["a", 1], ["b", 2]])
    await ingest(w, "jin10", [row("b"), row("c")], T0 + 60_000)
    await ingest(w, "jin10", [row("a"), row("b"), row("c")], T0 + 120_000)
    expect(got.map(g => g.map(i => i.itemId))).toEqual([["a", "b"], ["c"]])
  })

  it("取消订阅后不再通知；监听器抛错不影响入库与其他监听器", async () => {
    const w = await feedWorld()
    const other = vi.fn()
    w.store.onIngest(() => {
      throw new Error("boom")
    })
    const off = w.store.onIngest(other)
    await ingest(w, "jin10", [row("a")], T0)
    expect(other).toHaveBeenCalledTimes(1)
    off()
    await ingest(w, "jin10", [row("b")], T0 + 1)
    expect(other).toHaveBeenCalledTimes(1)
    expect((await w.service.query({})).items).toHaveLength(2)
  })

  it("多个源并发入库：通知里的 seq 严格递增，没有交错", async () => {
    const w = await feedWorld()
    const seqs: number[] = []
    w.store.onIngest(items => seqs.push(...items.map(i => i.seq)))
    await Promise.all(["jin10", "hackernews", "weibo", "user:a", "user:b"].map((s, k) =>
      ingest(w, s, Array.from({ length: 150 }, (_, i) => row(`${s}-${i}`)), T0 + k)))
    expect(seqs).toHaveLength(750)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(750)
  })

  it("seq 单调：同一条目更新不改 seq，新条目永远比旧的大", async () => {
    const w = await feedWorld()
    await ingest(w, "jin10", [row("a")], T0)
    await ingest(w, "weibo", [row("a")], T0 + 1)
    await ingest(w, "jin10", [row("a", { title: "改" }), row("z")], T0 + 2)
    const items = (await w.service.query({})).items.sort((a, b) => a.seq - b.seq)
    // 更新一条已有的也会耗掉一个 AUTOINCREMENT 值（SQLite 先分配再判冲突），所以 seq 之间可以有空洞，只保证单调
    expect(items.map(i => [i.sourceId, i.itemId])).toEqual([["jin10", "a"], ["weibo", "a"], ["jin10", "z"]])
    expect(items[0].seq).toBe(1)
    expect(items[1].seq).toBe(2)
    expect(items[2].seq).toBeGreaterThan(2)
  })
})

describe("items 表迁移（#2184 的旧表 → 带 seq 与 feed_ts）", () => {
  async function oldDb() {
    const db = createDatabase(sqlite({ name: ":memory:" }))
    await db.prepare(`CREATE TABLE items (source_id TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT, pub_date INTEGER, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (source_id, item_id))`).run()
    const ins = db.prepare(`INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?)`)
    await ins.run("jin10", "late", "晚到", "u", T0 - 1000, T0 + 2000, T0 + 2000)
    await ins.run("jin10", "hot", "热榜", "u", null, T0, T0 + 5000)
    await ins.run("weibo", "future", "时钟快", "u", T0 + 99_000, T0 + 1000, T0 + 1000)
    return db
  }

  it("补出 feed_ts（同一规则）、按首次出现的先后分配 seq，旧数据一条不丢，再 init 一次不变", async () => {
    const db = await oldDb()
    await db.prepare(`CREATE TABLE observations (source_id TEXT NOT NULL, item_id TEXT NOT NULL, observed_at INTEGER NOT NULL, rank INTEGER NOT NULL, extra TEXT, PRIMARY KEY (source_id, item_id, observed_at))`).run()
    await db.prepare(`INSERT INTO observations VALUES ('jin10', 'hot', ?, 1, NULL)`).run(T0)
    const store = new ObservationStore(db)
    await store.init()
    await store.init()
    const rows = await db.prepare(`SELECT seq, source_id, item_id, feed_ts, first_seen_at, last_seen_at FROM items ORDER BY seq`).all() as any[]
    expect(rows.map(r => [r.seq, r.item_id, r.feed_ts])).toEqual([[1, "hot", T0], [2, "future", T0 + 1000], [3, "late", T0 - 1000]])
    expect(rows[0].last_seen_at).toBe(T0 + 5000)
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM observations`).get() as any).n).toBe(1)
    // 迁移后新条目接着往下编号，且索引在
    await store.recordObservations("jin10", [row("new")], T0 + 10_000)
    expect((await db.prepare(`SELECT seq FROM items WHERE item_id = 'new'`).get() as any).seq).toBe(4)
    const idx = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'items'`).all() as any[]).map(r => r.name)
    expect(idx).toEqual(expect.arrayContaining(["idx_items_feed", "idx_items_source_feed", "idx_items_first_seen"]))
  })

  it("中途挂在「删旧表之后、改名之前」：下次启动只补改名，数据在", async () => {
    const db = await oldDb()
    const store = new ObservationStore(db)
    await store.init()
    // 模拟那个时刻的状态：items 被删了，items_v2 是完整的新表
    await db.prepare(`ALTER TABLE items RENAME TO items_v2`).run()
    await new ObservationStore(db).init()
    const tables = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as any[]).map(r => r.name)
    expect(tables).toContain("items")
    expect(tables).not.toContain("items_v2")
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as any).n).toBe(3)
  })
})
