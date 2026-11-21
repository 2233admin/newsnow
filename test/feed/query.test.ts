import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { T0, feedWorld, ingest, keyOf, pageAll, row } from "./helpers"
import { InputError } from "#/registry/spec"
import { feedTimestamp } from "#/collector/store"

describe("排序键（feed_ts）", () => {
  it("有发布时间用发布时间，没有用入库时间，晚于入库时间的发布时间按入库时间算", () => {
    expect(feedTimestamp(1000, 5000)).toBe(1000)
    expect(feedTimestamp(null, 5000)).toBe(5000)
    expect(feedTimestamp(9000, 5000)).toBe(5000)
    expect(feedTimestamp(5000, 5000)).toBe(5000)
  })

  it("入库后不再变：同一条目再次采集时发布时间变了，排序键与 seq 都不动", async () => {
    const w = await feedWorld()
    await ingest(w, "jin10", [row("a", { pubDate: T0 - 5000 })], T0)
    await ingest(w, "jin10", [row("a", { pubDate: T0 - 9000, title: "改了标题" })], T0 + 60_000)
    const { items } = await w.service.query({})
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ feedTs: T0 - 5000, firstSeenAt: T0, seq: 1, title: "改了标题" })
  })
})

describe("链接只给 http / https", () => {
  it("非 http(s) 的链接置空（javascript:、data:、相对路径、乱写），合法的原样保留", async () => {
    const w = await feedWorld()
    const urls = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "file:///etc/passwd", "//evil.example/x", "/relative", "not a url", "  https://ok.example/a?b=1  ", "http://ok.example/", "https://ok.example/中文"]
    await ingest(w, "jin10", urls.map((u, i) => row(`u${i}`, { url: u })), T0)
    await ingest(w, "jin10", [row("nourl", { url: null })], T0 + 1)
    const got = Object.fromEntries((await w.service.query({ limit: 50 })).items.map(i => [i.itemId, i.url]))
    expect(got).toEqual({
      u0: null,
      u1: null,
      u2: null,
      u3: null,
      u4: null,
      u5: null,
      u6: null,
      u7: null,
      u8: "https://ok.example/a?b=1",
      u9: "http://ok.example/",
      u10: "https://ok.example/中文",
      nourl: null,
    })
  })
})

describe("gET /api/feed 的查询", () => {
  async function seeded() {
    const w = await feedWorld()
    await ingest(w, "jin10", [row("j1", { pubDate: T0 - 3000, title: "美联储 加息 100% 预期" }), row("j2", { pubDate: T0 - 1000, title: "黄金 突破 2500" })], T0)
    await ingest(w, "hackernews", [row("h1", { title: "Show HN: A Tiny DB" }), row("h2", { title: "Rust 2026 edition" })], T0 + 1000)
    await ingest(w, "weibo", [row("w1", { title: "热搜 A" })], T0 + 2000)
    return w
  }

  it("默认按排序时间倒序，字段齐全，带来源显示名与分类", async () => {
    const w = await seeded()
    const res = await w.service.query({})
    expect(res.items.map(keyOf)).toEqual(["weibo/w1", "hackernews/h2", "hackernews/h1", "jin10/j2", "jin10/j1"])
    expect(res.items[0]).toMatchObject({ sourceName: "微博 实时热搜", category: "china", itemId: "w1", title: "热搜 A", feedTs: T0 + 2000, firstSeenAt: T0 + 2000, pubDate: null })
    expect(res.latestSeq).toBe(5)
    expect(res.nextCursor).toBeNull()
  })

  it("时间范围：from 含、to 不含", async () => {
    const w = await seeded()
    const ids = async (p: Record<string, unknown>) => (await w.service.query(p)).items.map(keyOf)
    expect(await ids({ from: T0 - 1000, to: T0 + 1000 })).toEqual(["jin10/j2"])
    expect(await ids({ from: new Date(T0 + 1000).toISOString() })).toEqual(["weibo/w1", "hackernews/h2", "hackernews/h1"])
    await expect(w.service.query({ from: T0, to: T0 })).rejects.toBeInstanceOf(InputError)
    await expect(w.service.query({ from: "不是时间" })).rejects.toBeInstanceOf(InputError)
  })

  it("来源：精确 id、逗号分隔、前缀（user:*）", async () => {
    const w = await seeded()
    w.state.descs.push({ id: "user:blog", name: "我的博客", category: "mine", builtin: false, enabled: true })
    await ingest(w, "user:blog", [row("b1")], T0 + 3000)
    const ids = async (p: Record<string, unknown>) => (await w.service.query(p)).items.map(keyOf)
    expect(await ids({ source: "jin10" })).toEqual(["jin10/j2", "jin10/j1"])
    expect(await ids({ source: "jin10,weibo" })).toEqual(["weibo/w1", "jin10/j2", "jin10/j1"])
    expect(await ids({ source: ["weibo", "hackernews"] })).toEqual(["weibo/w1", "hackernews/h2", "hackernews/h1"])
    expect(await ids({ source: "user:*" })).toEqual(["user:blog/b1"])
    expect(await ids({ source: "nope" })).toEqual([])
  })

  it("分类按注册表现算：用户改了分类，同一批历史条目立刻归到新分类", async () => {
    const w = await seeded()
    expect((await w.service.query({ category: "finance" })).items.map(keyOf)).toEqual(["jin10/j2", "jin10/j1"])
    w.state.descs[0] = { ...w.state.descs[0], category: "macro" }
    expect((await w.service.query({ category: "finance" })).items).toEqual([])
    expect((await w.service.query({ category: "macro" })).items.map(keyOf)).toEqual(["jin10/j2", "jin10/j1"])
  })

  it("关键词：每个词都要在标题里；% 与 _ 当字面字符", async () => {
    const w = await seeded()
    const ids = async (q: string) => (await w.service.query({ q })).items.map(keyOf)
    expect(await ids("黄金")).toEqual(["jin10/j2"])
    expect(await ids("黄金 2500")).toEqual(["jin10/j2"])
    expect(await ids("黄金 加息")).toEqual([])
    expect(await ids("show hn")).toEqual(["hackernews/h1"]) // ASCII 不分大小写
    expect(await ids("100%")).toEqual(["jin10/j1"])
    expect(await ids("%")).toEqual(["jin10/j1"]) // 不是通配
    expect(await ids("_")).toEqual([])
    await expect(w.service.query({ q: "a b c d e f" })).rejects.toBeInstanceOf(InputError)
  })

  it("拉新 since：按入库时间、含端点", async () => {
    const w = await seeded()
    const ids = async (since: number) => (await w.service.query({ since })).items.map(keyOf)
    expect(await ids(T0 + 1000)).toEqual(["weibo/w1", "hackernews/h2", "hackernews/h1"])
    expect(await ids(T0 + 1001)).toEqual(["weibo/w1"])
    expect(await ids(T0 + 5000)).toEqual([])
  })

  it("停用与已删除的源的历史条目默认不出现，includeInactive 才有", async () => {
    const w = await seeded()
    w.state.descs[1] = { ...w.state.descs[1], enabled: false } // hackernews 停用
    const ids = async (p: Record<string, unknown>) => (await w.service.query(p)).items.map(keyOf)
    expect(await ids({})).toEqual(["weibo/w1", "jin10/j2", "jin10/j1"])
    expect(await ids({ includeInactive: "1" })).toHaveLength(5)
    // 已不在注册表里的源（用户源被删了）
    await ingest(w, "user:gone", [row("g1")], T0 + 4000)
    expect(await ids({})).not.toContain("user:gone/g1")
    expect(await ids({ includeInactive: true })).toContain("user:gone/g1")
    expect(await ids({ includeInactive: true, source: "user:gone" })).toEqual(["user:gone/g1"])
  })

  it("标的筛选未实装：返回空并明说", async () => {
    const w = await seeded()
    const res = await w.service.query({ symbol: "600519" })
    expect(res.items).toEqual([])
    expect(res.unimplemented).toEqual(["symbol"])
    expect((await w.service.query({})).unimplemented).toBeUndefined()
  })

  it("limit 与 cursor 的入参校验", async () => {
    const w = await seeded()
    for (const limit of [0, 201, 1.5, "abc", -1]) await expect(w.service.query({ limit })).rejects.toBeInstanceOf(InputError)
    await expect(w.service.query({ cursor: "乱写的" })).rejects.toMatchObject({ status: 400 })
    await expect(w.service.query({ cursor: Buffer.from("[1]").toString("base64url") })).rejects.toBeInstanceOf(InputError)
    expect((await w.service.query({ limit: "2" })).items).toHaveLength(2)
  })

  it("source 与 category 同时给是交集；来源集合再大也只用一个绑定参数（D1 的 100 个上限）", async () => {
    const w = await seeded()
    expect((await w.service.query({ source: "jin10,weibo", category: "china" })).items.map(keyOf)).toEqual(["weibo/w1"])
    for (let i = 0; i < 250; i++) w.state.descs.push({ id: `user:s${i}`, name: `s${i}`, category: "bulk", builtin: false, enabled: true })
    const res = await w.service.query({ category: "bulk" }) // 250 个来源 id
    expect(res.items).toEqual([])
    const prepared: string[] = []
    const orig = w.db.prepare.bind(w.db)
    w.db.prepare = ((sql: string) => {
      prepared.push(sql)
      return orig(sql)
    }) as typeof w.db.prepare
    await w.service.query({ category: "bulk" })
    expect(prepared.join("\n")).toContain("json_each(?)")
    expect((prepared.join("\n").match(/\?/g) ?? []).length).toBeLessThan(20)
  })
})

describe("游标翻页：不重复、不遗漏", () => {
  it("同一毫秒里有很多条（跨源、同源）时顺序确定，翻页不丢不重", async () => {
    const w = await feedWorld()
    // 三个源在同一时刻各入 30 条（feed_ts 全相同），再加一批发布时间相同的
    for (const s of ["jin10", "hackernews", "weibo"]) await ingest(w, s, Array.from({ length: 30 }, (_, i) => row(`${s}-${i}`)), T0)
    await ingest(w, "jin10", Array.from({ length: 20 }, (_, i) => row(`p${i}`, { pubDate: T0 - 1 })), T0 + 5)
    const pages = await pageAll(w.service, { limit: 7 })
    const keys = pages.flatMap(p => p.items.map(keyOf))
    expect(keys).toHaveLength(110)
    expect(new Set(keys).size).toBe(110)
    const sorted = [...keys].sort().reverse()
    // 排序键 (feedTs, sourceId, itemId) 倒序：先 T0 那批（按 sourceId、itemId 倒序），再 T0-1 那批
    const flat = pages.flatMap(p => p.items)
    for (let i = 1; i < flat.length; i++) {
      const a = flat[i - 1]
      const b = flat[i]
      const ka = [a.feedTs, a.sourceId, a.itemId] as const
      const kb = [b.feedTs, b.sourceId, b.itemId] as const
      expect(ka[0] > kb[0] || (ka[0] === kb[0] && (ka[1] > kb[1] || (ka[1] === kb[1] && ka[2] > kb[2])))).toBe(true)
    }
    expect(sorted).toHaveLength(110)
  })

  it("一万条灌入后从头翻到底：每页 200 条，无重复、无遗漏，与按键排序的期望完全一致", async () => {
    const w = await feedWorld()
    const sources = ["jin10", "hackernews", "weibo", "user:a", "user:b"]
    const expected: { feedTs: number, key: string, sourceId: string, itemId: string }[] = []
    let n = 0
    for (let batch = 0; batch < 100; batch++) {
      const sourceId = sources[batch % sources.length]
      const observedAt = T0 + batch * 60_000
      const rows = Array.from({ length: 100 }, (_, i) => {
        // 一半有发布时间（刻意取很粗的粒度制造大量并列），一半没有（用入库时间）
        const pubDate = i % 2 ? observedAt - (i % 7) * 60_000 : null
        return row(`${batch}-${i}`, { pubDate })
      })
      await ingest(w, sourceId, rows, observedAt)
      for (const r of rows) {
        expected.push({ feedTs: r.pubDate === null ? observedAt : Math.min(r.pubDate, observedAt), key: `${sourceId}/${r.itemId}`, sourceId, itemId: r.itemId })
        n++
      }
    }
    expect(n).toBe(10_000)
    expected.sort((a, b) => b.feedTs - a.feedTs || (a.sourceId < b.sourceId ? 1 : a.sourceId > b.sourceId ? -1 : 0) || (a.itemId < b.itemId ? 1 : a.itemId > b.itemId ? -1 : 0))
    const pages = await pageAll(w.service, { limit: 200 })
    expect(pages).toHaveLength(50)
    const keys = pages.flatMap(p => p.items.map(keyOf))
    expect(new Set(keys).size).toBe(10_000)
    expect(keys).toEqual(expected.map(e => e.key))
  })

  it("翻页期间不断有新条目入库：翻过的与没翻到的各不重复，新入库的由 since / seq 补上，合起来一条不少", async () => {
    const w = await feedWorld()
    for (let b = 0; b < 40; b++) await ingest(w, "jin10", Array.from({ length: 50 }, (_, i) => row(`o${b}-${i}`, { pubDate: T0 - (b * 50 + i) * 1000 })), T0)
    const before = (await w.service.query({ limit: 1 })).latestSeq
    expect(before).toBe(2000)

    const seen: string[] = []
    let injected = 0
    const pages = await pageAll(w.service, { limit: 100 }, async (i) => {
      // 每翻一页就入库三批：比流顶还新的、落在已翻过区域里的（发布时间旧但落在游标之上的位置）、落在还没翻到的区域里的
      await ingest(w, "hackernews", [row(`n${i}-top`)], T0 + 10_000 + i)
      await ingest(w, "hackernews", [row(`n${i}-mid`, { pubDate: T0 - 500 - i })], T0 + 20_000 + i)
      await ingest(w, "hackernews", [row(`n${i}-deep`, { pubDate: T0 - 1_900_000 - i })], T0 + 30_000 + i)
      injected += 3
    })
    for (const p of pages) seen.push(...p.items.map(keyOf))
    expect(new Set(seen).size).toBe(seen.length) // 翻页本身不重复

    const original = new Set(Array.from({ length: 2000 }, (_, k) => `jin10/o${Math.floor(k / 50)}-${k % 50}`))
    for (const k of original) expect(seen, k).toContain(k) // 开始时就在的一条不漏

    // 翻页期间新入库的：翻页读到的 + 之后按 since 拉到的，合起来一条不少
    const fresh = await w.service.query({ since: T0 + 10_000, limit: 200 })
    const union = new Set([...seen, ...fresh.items.map(keyOf)])
    expect(fresh.items).toHaveLength(injected)
    for (let i = 0; i < injected / 3; i++) {
      for (const part of ["top", "mid", "deep"]) expect(union.has(`hackernews/n${i}-${part}`)).toBe(true)
    }
    expect(pages.at(-1)!.latestSeq).toBeGreaterThan(before)
    // 场景确实造出来了：落在已翻过区域的只能靠 since 补，落在没翻到区域的被翻页读到了
    expect(seen).not.toContain("hackernews/n0-mid")
    expect(seen).toContain(`hackernews/n0-deep`)
  })

  it("过滤条件很窄时（目标源的条目都在扫描窗口之外）退回整查询，结果仍然完整；宽的过滤只扫窗口", async () => {
    const w = await feedWorld()
    const { FeedStore } = await import("#/feed/store")
    const { createFeedService } = await import("#/feed/service")
    const small = createFeedService({ store: new FeedStore(w.db, 100), describe: async () => w.state.descs })
    await ingest(w, "weibo", Array.from({ length: 5 }, (_, i) => row(`rare${i}`, { pubDate: T0 - 10_000_000 - i })), T0)
    for (let b = 0; b < 3; b++) await ingest(w, "jin10", Array.from({ length: 100 }, (_, i) => row(`c${b}-${i}`, { pubDate: T0 - (b * 100 + i) * 10 })), T0)
    const statements: string[] = []
    const orig = w.db.prepare.bind(w.db)
    w.db.prepare = ((sql: string) => {
      statements.push(sql)
      return orig(sql)
    }) as typeof w.db.prepare
    const rare = await small.query({ source: "weibo" })
    expect(rare.items.map(keyOf)).toEqual(["weibo/rare0", "weibo/rare1", "weibo/rare2", "weibo/rare3", "weibo/rare4"])
    expect(statements.filter(q => q.includes("ORDER BY"))).toHaveLength(2) // 窗口里没凑够 → 整查询
    statements.length = 0
    const wide = await small.query({ source: "jin10", limit: 50 })
    expect(wide.items).toHaveLength(50)
    expect(wide.nextCursor).toBeTruthy()
    expect(statements.filter(q => q.includes("ORDER BY"))).toHaveLength(1) // 窗口里凑够一页，不用整查询
    // 与不带窗口的结果逐条一致
    const full = await w.service.query({ source: "jin10", limit: 50 })
    expect(wide.items).toEqual(full.items)
    const pagesSmall = await pageAll(small, { source: "jin10,weibo", limit: 40 })
    const pagesFull = await pageAll(w.service, { source: "jin10,weibo", limit: 40 })
    expect(pagesSmall.flatMap(p => p.items.map(keyOf))).toEqual(pagesFull.flatMap(p => p.items.map(keyOf)))
    expect(pagesSmall.flatMap(p => p.items)).toHaveLength(305)
  })

  it("查询计划：翻页走 idx_items_feed，不对全表做临时排序", async () => {
    const w = await feedWorld()
    await ingest(w, "jin10", Array.from({ length: 50 }, (_, i) => row(`x${i}`)), T0)
    const plan = async (sql: string, ...params: (string | number)[]) => ((await w.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)) as { detail: string }[]).map(r => r.detail).join(" | ")
    const unfiltered = await plan(`SELECT * FROM items ORDER BY feed_ts DESC, source_id DESC, item_id DESC LIMIT 51`)
    expect(unfiltered).toContain("idx_items_feed")
    expect(unfiltered).not.toContain("TEMP B-TREE")
    const withCursor = await plan(`SELECT * FROM items WHERE (feed_ts, source_id, item_id) < (?, ?, ?) ORDER BY feed_ts DESC, source_id DESC, item_id DESC LIMIT 51`, T0, "jin10", "x1")
    expect(withCursor).toContain("idx_items_feed")
    expect(withCursor).not.toContain("TEMP B-TREE")
  })
})
