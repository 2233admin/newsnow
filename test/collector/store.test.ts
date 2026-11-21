import { describe, expect, it } from "vitest"
import type { NewsItem } from "@shared/types"
import { memoryStore, selectAll } from "./helpers"
import { toObservedRows, toTimestamp } from "#/collector/store"

describe("toTimestamp", () => {
  it("毫秒数原样保留，字符串按日期解析，认不出的是 null", () => {
    expect(toTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(toTimestamp("Sat, 21 Nov 2026 12:37:13 GMT")).toBe(Date.UTC(2026, 10, 21, 12, 37, 13))
    expect(toTimestamp("不是日期")).toBeNull()
    expect(toTimestamp(undefined)).toBeNull()
    expect(toTimestamp(0)).toBeNull()
  })
})

describe("toObservedRows", () => {
  it("丢掉缺 id 或标题的、同 id 去重、名次按保留下来的顺序从 1 起", () => {
    const items = [
      { id: "a", title: "甲", url: "u/a" },
      { id: "", title: "无 id", url: "u/x" },
      { id: "b", title: "  ", url: "u/b" },
      { id: "a", title: "甲（重复）", url: "u/a2" },
      { id: 7, title: "丙", url: "u/c", extra: { info: "99" } },
    ] as NewsItem[]
    const rows = toObservedRows(items, 200)
    expect(rows.map(r => [r.itemId, r.rank])).toEqual([["a", 1], ["7", 2]])
    expect(rows[1].extra).toBe(JSON.stringify({ info: "99" }))
  })

  it("超过上限的截断", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, title: `t${i}`, url: "u" })) as NewsItem[]
    expect(toObservedRows(items, 3)).toHaveLength(3)
  })
})

describe("observationStore", () => {
  it("同一条新闻再次出现：first_seen_at 不动，last_seen_at 更新，名次历史每次都留", async () => {
    const { store, db } = await memoryStore()
    await store.recordObservations("weibo", toObservedRows([
      { id: "x", title: "热搜 X", url: "u/x" },
      { id: "y", title: "热搜 Y", url: "u/y" },
    ], 200), 1000)
    await store.recordObservations("weibo", toObservedRows([
      { id: "y", title: "热搜 Y（改标题）", url: "u/y" },
      { id: "x", title: "热搜 X", url: "u/x", extra: { info: "爆" } },
    ], 200), 2000)

    const x = await store.getItemHistory("weibo", "x")
    expect(x?.item.firstSeenAt).toBe(1000)
    expect(x?.item.lastSeenAt).toBe(2000)
    expect(x?.observations).toEqual([
      { observedAt: 1000, rank: 1, extra: null },
      { observedAt: 2000, rank: 2, extra: { info: "爆" } },
    ])
    const y = await store.getItemHistory("weibo", "y")
    expect(y?.item.title).toBe("热搜 Y（改标题）")
    expect(y?.observations.map(o => o.rank)).toEqual([2, 1])

    // 没有被覆盖成一份：2 条 items，4 条 observations
    expect(await selectAll(db, "SELECT * FROM items")).toHaveLength(2)
    expect(await selectAll(db, "SELECT * FROM observations")).toHaveLength(4)
  })

  it("重复写入同一次观测是幂等的", async () => {
    const { store, db } = await memoryStore()
    const rows = toObservedRows([{ id: "a", title: "甲", url: "u" }], 200)
    await store.recordObservations("s", rows, 1000)
    await store.recordObservations("s", rows, 1000)
    expect(await selectAll(db, "SELECT * FROM observations")).toHaveLength(1)
  })

  it("发布时间：之后的观测没带就保留原值，带了就更新", async () => {
    const { store } = await memoryStore()
    await store.recordObservations("s", toObservedRows([{ id: "a", title: "甲", url: "u", pubDate: 5000 }], 200), 1000)
    await store.recordObservations("s", toObservedRows([{ id: "a", title: "甲", url: "u" }], 200), 2000)
    expect((await store.getItemHistory("s", "a"))?.item.pubDate).toBe(5000)
    await store.recordObservations("s", toObservedRows([{ id: "a", title: "甲", url: "u", pubDate: 6000 }], 200), 3000)
    expect((await store.getItemHistory("s", "a"))?.item.pubDate).toBe(6000)
  })

  it("不同源里 id 相同的条目互不影响", async () => {
    const { store } = await memoryStore()
    await store.recordObservations("a", toObservedRows([{ id: "1", title: "来自 a", url: "u" }], 200), 1000)
    await store.recordObservations("b", toObservedRows([{ id: "1", title: "来自 b", url: "u" }], 200), 1000)
    expect((await store.getItemHistory("a", "1"))?.item.title).toBe("来自 a")
    expect((await store.getItemHistory("b", "1"))?.item.title).toBe("来自 b")
  })

  it("超过一条语句参数上限的大批量也能写（分块）", async () => {
    const { store, db } = await memoryStore()
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `id${i}`, title: `标题${i}`, url: `u/${i}` })) as NewsItem[]
    await store.recordObservations("big", toObservedRows(items, 200), 1000)
    expect(await selectAll(db, "SELECT * FROM items")).toHaveLength(200)
    expect(await selectAll(db, "SELECT * FROM observations")).toHaveLength(200)
  })

  it("标题里的引号与分号只是数据，不会进到 SQL 里", async () => {
    const { store, db } = await memoryStore()
    const evil = `x'); DROP TABLE items; --`
    await store.recordObservations(`s'x`, toObservedRows([{ id: evil, title: evil, url: evil }], 200), 1000)
    expect((await store.getItemHistory(`s'x`, evil))?.item.title).toBe(evil)
    expect(await selectAll(db, "SELECT * FROM items")).toHaveLength(1)
  })

  it("健康：成功清零连续失败，失败累加并留下最近错误", async () => {
    const { store } = await memoryStore()
    await store.recordFailure("s", 1000, new Error("boom"))
    await store.recordFailure("s", 2000, new Error("boom again"))
    let [h] = await store.getHealth()
    expect(h).toMatchObject({ sourceId: "s", consecutiveFailures: 2, lastError: "boom again", lastErrorAt: 2000, lastAttemptAt: 2000, lastSuccessAt: null })

    await store.recordSuccess("s", 3000, 12)
    ;[h] = await store.getHealth()
    expect(h).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: 3000, lastAttemptAt: 3000, lastItemCount: 12 })
    // 最近一次错误还留着，方便事后看
    expect(h.lastError).toBe("boom again")
  })

  it("错误信息里的 URL 去掉查询串与 fragment，只留 origin + path", async () => {
    const { store } = await memoryStore()
    await store.recordFailure("s", 1, new Error(`[GET] "https://api.example.com/v1/hot?token=SECRET&sig=abc#x": 403 Forbidden (http://b.test/p?k=v)`))
    const [h] = await store.getHealth()
    expect(h.lastError).toBe(`[GET] "https://api.example.com/v1/hot": 403 Forbidden (http://b.test/p)`)
    expect(h.lastError).not.toContain("SECRET")
  })

  it("错误信息过长会截断", async () => {
    const { store } = await memoryStore()
    await store.recordFailure("s", 1, new Error("x".repeat(5000)))
    const [h] = await store.getHealth()
    expect(h.lastError).toHaveLength(500)
  })
})
