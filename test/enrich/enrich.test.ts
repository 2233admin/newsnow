import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { describe, expect, it, vi } from "vitest"
import { T0, descriptors, feedWorld, ingest, keyOf, row } from "../feed/helpers"
import { normalizeFeedParams } from "#/feed/params"
import { openFeedStream } from "#/feed/stream"
import type { StreamEvent } from "#/feed/stream"
import { ObservationStore } from "#/collector/store"
import { ENRICH_VERSION, createEnricher } from "#/enrich/enrich"
import { TITLE_WINDOW_MS } from "#/enrich/dedup"

const H = 3600_000
function DESCS() {
  return descriptors([
    { id: "cls-telegraph", name: "财联社电报", category: "finance", builtin: true, enabled: true },
    { id: "wallstreetcn-quick", name: "华尔街见闻快讯", category: "finance", builtin: true, enabled: true },
    { id: "ths", name: "同花顺快讯", category: "finance", builtin: true, enabled: true },
    { id: "user:reuters", name: "Reuters Markets", category: "财经", builtin: false, enabled: true },
    { id: "user:reuters2", name: "Reuters Business", category: "财经", builtin: false, enabled: true },
    { id: "user:tc", name: "TechCrunch", category: "tech", builtin: false, enabled: true },
  ])
}
const world = (descs = DESCS()) => feedWorld(descs, { enrich: true })

/** 同一条快讯三个源各写一遍：前缀、后缀、标点各不相同（取自 2026-11-21 真采集的 cls 与华尔街见闻）。 */
const FLASH = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
function three(w: { store: ObservationStore }, t = T0) {
  return Promise.all([
    ingest(w, "cls-telegraph", [row("c1", { title: FLASH, url: "https://www.cls.cn/detail/2540805" })], t),
    ingest(w, "wallstreetcn-quick", [row("w1", { title: `财联社11月21日电，${FLASH}。`, url: "https://wallstreetcn.com/livenews/3203654" })], t + 1000),
    ingest(w, "ths", [row("t1", { title: `${FLASH}（新华社）`, url: "https://news.10jqka.com.cn/20261121/c1.shtml" })], t + 2000),
  ])
}

describe("去重合并：同一条快讯被三个源转载，流里只出现一行", () => {
  it("默认一行，来源数 3，带成员；expand 才展开成三行", async () => {
    const w = await world()
    await three(w)
    const res = await w.service.query({})
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({ sourceId: "cls-telegraph", itemId: "c1", sourcesCount: 3, groupId: res.items[0].seq, dupOf: null })
    expect(res.items[0].members.map(m => [m.sourceId, m.itemId, m.sourceName])).toEqual([["wallstreetcn-quick", "w1", "华尔街见闻快讯"], ["ths", "t1", "同花顺快讯"]])
    const all = await w.service.query({ expand: "1" })
    expect(all.items.map(keyOf)).toEqual(["ths/t1", "wallstreetcn-quick/w1", "cls-telegraph/c1"])
    expect(all.items.map(i => [i.dupOf, i.sourcesCount])).toEqual([[1, 3], [1, 3], [null, 3]])
    expect(all.items[0].members).toEqual([])
  })

  it("正面证明：没有富化器时同样的输入是三行", async () => {
    const w = await feedWorld(undefined, { enrich: false })
    await ingest(w, "jin10", [row("c1", { title: FLASH, url: "https://x.example/1" })], T0)
    await ingest(w, "weibo", [row("w1", { title: FLASH, url: "https://x.example/2" })], T0 + 1000)
    await ingest(w, "hackernews", [row("t1", { title: FLASH, url: "https://x.example/3" })], T0 + 2000)
    expect((await w.service.query({})).items).toHaveLength(3)
    expect((await w.service.query({})).items[0].sourcesCount).toBe(1)
  })

  it("同一个源重发同一条（不同 item_id）也并，来源数只算 1 个源", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("a", { title: FLASH, url: null })], T0)
    await ingest(w, "cls-telegraph", [row("b", { title: FLASH, url: null })], T0 + 60_000)
    const res = await w.service.query({})
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({ itemId: "a", sourcesCount: 1 })
    expect(res.items[0].members).toHaveLength(1)
  })

  it("链接相同就并（标题不同也并）；链接是站点首页的不算", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("a", { title: "完全不同的写法甲：关于某项政策的长篇报道", url: "https://news.example.com/p/123?utm_source=x" })], T0)
    await ingest(w, "ths", [row("b", { title: "另一种写法乙：同一篇文章被另一个源转载时改了标题", url: "https://www.news.example.com/p/123/" })], T0 + 1000)
    await ingest(w, "ths", [row("h1", { title: "首页链接的第一条与别的新闻没有关系的内容", url: "https://news.example.com/" })], T0 + 2000)
    await ingest(w, "cls-telegraph", [row("h2", { title: "首页链接的第二条同样与上面那条毫不相干的内容", url: "https://news.example.com/" })], T0 + 3000)
    const res = await w.service.query({})
    expect(res.items.map(i => [i.itemId, i.sourcesCount])).toEqual([["h2", 1], ["h1", 1], ["a", 2]])
  })

  it("标题归一后相同才并；太短的标题（套话）不并", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("a", { title: "早报", url: null }), row("s1", { title: "美股收盘涨跌不一", url: null })], T0)
    await ingest(w, "ths", [row("b", { title: "早报", url: null }), row("s2", { title: "美股收盘涨跌不一", url: null })], T0 + 1000)
    expect((await w.service.query({})).items).toHaveLength(4)
  })

  it("数字不同的同一模板是两件事，不并（相似度的数字保护）", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("a", { title: "美元指数日内下跌0.3%，报104.52，创一周新低，非美货币普遍走强", url: null })], T0)
    await ingest(w, "ths", [row("b", { title: "美元指数日内下跌0.4%，报104.52，创一周新低，非美货币普遍走强", url: null })], T0 + 1000)
    await ingest(w, "wallstreetcn-quick", [row("c", { title: "美元指数日内下跌0.3%，报104.52，创一周新低，非美货币普遍走强。", url: null })], T0 + 2000)
    const res = await w.service.query({})
    expect(res.items.map(i => [i.itemId, i.sourcesCount])).toEqual([["b", 1], ["a", 2]])
  })

  it("窗口：隔了两天以上的同一标题不并", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("a", { title: "每周一例的固定栏目：本周重要经济数据与事件前瞻", url: null })], T0)
    await ingest(w, "cls-telegraph", [row("b", { title: "每周一例的固定栏目：本周重要经济数据与事件前瞻", url: null })], T0 + TITLE_WINDOW_MS + H)
    expect((await w.service.query({})).items).toHaveLength(2)
    await ingest(w, "ths", [row("c", { title: "每周一例的固定栏目：本周重要经济数据与事件前瞻", url: null })], T0 + TITLE_WINDOW_MS + 2 * H)
    expect((await w.service.query({})).items.map(i => [i.itemId, i.sourcesCount])).toEqual([["b", 2], ["a", 1]])
  })

  it("同一批里的重复也并：主条目是批里 seq 最小的", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("x1", { title: FLASH, url: null }), row("x2", { title: FLASH, url: null }), row("y", { title: "不相干的另一条独立的新闻内容足够长了", url: null })], T0)
    const res = await w.service.query({})
    expect(res.items.map(i => [i.itemId, i.sourcesCount])).toEqual([["y", 1], ["x1", 1]])
    expect(res.items[1].members.map(m => m.itemId)).toEqual(["x2"])
  })

  it("同时匹配两个已有的组：并入主条目更早的那个，两个组不合并，主条目不动", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("a", { title: "甲组：完全独特的标题一二三四五六七八九", url: "https://e.example/a" })], T0)
    await ingest(w, "ths", [row("b", { title: "乙组：另一个完全不同的独特标题九八七六五四三二一", url: "https://e.example/b" })], T0 + 1)
    // c 的链接匹配 b、标题匹配 a
    await ingest(w, "wallstreetcn-quick", [row("c", { title: "甲组：完全独特的标题一二三四五六七八九", url: "https://e.example/b" })], T0 + 2)
    const res = await w.service.query({})
    expect(res.items.map(i => [i.itemId, i.sourcesCount])).toEqual([["b", 1], ["a", 2]])
  })
})

describe("游标、seq 与 SSE 的不重不漏", () => {
  it("翻页期间同组来了新成员：主条目的位置、游标与内容不变，翻出的每一行恰好一次，新成员只改计数", async () => {
    const w = await world()
    // 60 条各不相同的快讯，每 3 条里第 1 条在翻页中途会被别的源转载
    const titles = Array.from({ length: 60 }, (_, i) => `第${i}号独立事件：这是一条足够长的快讯标题用来避免被误并 ${i * 7919}`)
    for (let i = 0; i < 60; i++) await ingest(w, "cls-telegraph", [row(`m${i}`, { title: titles[i], url: `https://cls.example/${i}`, pubDate: T0 - i * 1000 })], T0 + i)
    const before = (await w.service.query({ limit: 200 })).items
    const seen: string[] = []
    let cursor: string | undefined
    let late = 0
    for (let page = 0; page < 20; page++) {
      const res = await w.service.query({ limit: 10, cursor })
      seen.push(...res.items.map(keyOf))
      if (page === 1) {
        // 翻到第 2 页之后：已翻过的区域（m0..m19 在前，因为 pubDate 倒序）与没翻到的区域各来几个成员，外加几条全新的
        for (const i of [0, 5, 30, 45, 59]) {
          await ingest(w, "wallstreetcn-quick", [row(`late${i}`, { title: titles[i], url: `https://wscn.example/${i}` })], T0 + 10_000 + late++)
        }
      }
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toEqual(before.map(keyOf)) // 与翻页前的全量一模一样：没有重复、没有遗漏、顺序不变
    const after = (await w.service.query({ limit: 200 })).items
    expect(after.map(i => [i.seq, i.feedTs, i.itemId])).toEqual(before.map(i => [i.seq, i.feedTs, i.itemId]))
    expect(after.filter(i => i.sourcesCount === 2).map(i => i.itemId).sort()).toEqual(["m0", "m30", "m45", "m5", "m59"])
  })

  it("seq 单调不空涨：成员也占一个 seq，主条目的 seq 不变；重复采集同一批不耗号", async () => {
    const w = await world()
    await three(w)
    expect(await w.feedStore.latestSeq()).toBe(3)
    const first = (await w.service.query({ expand: true })).items.map(i => [i.itemId, i.seq])
    await ingest(w, "ths", [row("t1", { title: `${FLASH}（新华社）`, url: "https://news.10jqka.com.cn/20261121/c1.shtml" })], T0 + 99_000)
    expect(await w.feedStore.latestSeq()).toBe(3)
    expect((await w.service.query({ expand: true })).items.map(i => [i.itemId, i.seq])).toEqual(first)
  })

  it("sSE 默认：主条目推 item，后到的成员推 merge（带现在的来源数），不单独推成员；expand 时成员也推 item", async () => {
    const w = await world()
    const open = async (query: Record<string, unknown>, lastEventId?: number) => {
      const events: StreamEvent[] = []
      const handle = openFeedStream({ store: w.store, feed: w.feedStore, describe: async () => w.state.descs }, normalizeFeedParams(query), lastEventId, e => events.push(e))
      await handle.ready
      return { events, handle }
    }
    const collapsed = await open({})
    const expanded = await open({ expand: "1" })
    await three(w)
    await vi.waitFor(() => expect(collapsed.events.filter(e => e.type !== "ready")).toHaveLength(3))
    expect(collapsed.events.slice(1).map(e => e.type === "item" ? ["item", e.item.itemId, e.item.sourcesCount] : e.type === "merge" ? ["merge", e.seq, e.groupId, e.sourcesCount, e.sourceId] : [e.type])).toEqual([
      ["item", "c1", 1],
      ["merge", 2, 1, 2, "wallstreetcn-quick"],
      ["merge", 3, 1, 3, "ths"],
    ])
    await vi.waitFor(() => expect(expanded.events.filter(e => e.type === "item")).toHaveLength(3))
    // 带 Last-Event-ID 补发走同一套规则
    const replay = await open({}, 0)
    expect(replay.events.slice(1).map(e => e.type)).toEqual(["item", "merge", "merge"])
    const replayItem = replay.events.find(e => e.type === "item") as Extract<StreamEvent, { type: "item" }>
    expect(replayItem.item.sourcesCount).toBe(3) // 补发时主条目已经带着最新的来源数
    for (const c of [collapsed, expanded, replay]) c.handle.close()
  })
})

describe("清洗标题", () => {
  it("实体解码：cleanTitle 解了，原始 title 不变；q 搜得到解码后的写法", async () => {
    const w = await world()
    await ingest(w, "user:tc", [row("t1", { title: "OpenAI&#8217;s new model beats Google&#8217;s &amp; Meta&#8217;s on benchmarks", url: "https://techcrunch.com/2026/11/21/openai-model/" })], T0)
    const res = await w.service.query({ q: "OpenAI’s" })
    expect(res.items).toHaveLength(1)
    expect(res.items[0].title).toContain("&#8217;")
    expect(res.items[0].cleanTitle).toBe("OpenAI’s new model beats Google’s & Meta’s on benchmarks")
    expect((await w.service.query({ q: "&#8217;" })).items).toHaveLength(1) // 原标题也搜得到
  })

  it("google News：去来源后缀、两个 Google 源里同一篇（链接相同）合并", async () => {
    const w = await world()
    const link = "https://news.google.com/rss/articles/CBMingFBVV95cUxNWXlDbDhlc09IVzVHS0dKcmt0cDVXd3ZR?oc=5"
    await ingest(w, "user:reuters", [row("g1", { title: "NATO will defend every inch of Polish territory, Rutte says - Reuters", url: link })], T0)
    await ingest(w, "user:reuters2", [row("g2", { title: "NATO will defend every inch of Polish territory, Rutte says - Reuters", url: link })], T0 + 1000)
    const res = await w.service.query({})
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({ cleanTitle: "NATO will defend every inch of Polish territory, Rutte says", sourcesCount: 2, origUrl: null })
    expect(res.items[0].title.endsWith(" - Reuters")).toBe(true)
    expect(res.items[0].url).toBe(link) // 解不出原文时保留跳转链接
  })

  it("google News 与别的源：清洗后标题相同就并（后缀不再挡路）", async () => {
    const w = await world()
    await ingest(w, "user:tc", [row("a", { title: "Nvidia shares tumble 14% as AI trade unwinds", url: "https://other.example/nvda" })], T0)
    await ingest(w, "user:reuters", [row("g", { title: "Nvidia shares tumble 14% as AI trade unwinds - Reuters", url: "https://news.google.com/rss/articles/CBMiXYZ?oc=5" })], T0 + 1000)
    const res = await w.service.query({})
    expect(res.items).toHaveLength(1)
    expect(res.items[0].sourcesCount).toBe(2)
  })
})

describe("标的筛选（真筛选）", () => {
  async function seeded() {
    const w = await world()
    await ingest(w, "cls-telegraph", [
      row("moutai", { title: "贵州茅台（600519）公告回购股份", url: "https://cls.example/1" }),
      row("nvda", { title: "英伟达暴跌14%，纳指重挫5%", url: "https://cls.example/2" }),
      row("btc", { title: "比特币跌破56000美元", url: "https://cls.example/3" }),
      row("none", { title: "国家数据局：积极拓展词元服务应用场景", url: "https://cls.example/4" }),
    ], T0)
    return w
  }

  it("a 股、美股、加密币各查一个", async () => {
    const w = await seeded()
    const itemIds = async (symbol: string) => (await w.service.query({ symbol })).items.map(i => i.itemId)
    expect(await itemIds("600519.XSHG")).toEqual(["moutai"])
    expect(await itemIds("NVDA.XNAS")).toEqual(["nvda"])
    expect(await itemIds("BTCUSDT.BINANCE")).toEqual(["btc"])
    expect(await itemIds("AAPL.XNAS")).toEqual([])
    expect((await w.service.query({ symbol: "600519.XSHG,NVDA.XNAS" })).items.map(i => i.itemId)).toEqual(["nvda", "moutai"])
    expect((await w.service.query({})).items.find(i => i.itemId === "moutai")!.symbols).toEqual(["600519.XSHG"])
  })

  it("正面证明：关掉标的识别（词典匹配返回空）时同样的查询变成空", async () => {
    const w = await feedWorld(undefined, { enrich: false })
    await ingest(w, "jin10", [row("moutai", { title: "贵州茅台（600519）公告回购股份" })], T0)
    expect((await w.service.query({ symbol: "600519.XSHG" })).items).toEqual([])
  })

  it("按组命中：成员带标的而主条目没有，默认返回主条目；expand 只返回带标的的那一条", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("main", { title: "某公司披露重大事项，股价盘中异动，详情待公告说明", url: "https://e.example/x" })], T0)
    await ingest(w, "ths", [row("member", { title: "某公司披露重大事项，股价盘中异动，详情待公告说明（贵州茅台）", url: "https://e.example/x" })], T0 + 1000)
    expect((await w.service.query({ symbol: "600519.XSHG" })).items.map(i => [i.itemId, i.sourcesCount])).toEqual([["main", 2]])
    expect((await w.service.query({ symbol: "600519.XSHG", expand: true })).items.map(i => i.itemId)).toEqual(["member"])
  })

  it("与关键词、来源、游标组合；翻页不重不漏", async () => {
    const w = await world()
    for (let i = 0; i < 25; i++) await ingest(w, "cls-telegraph", [row(`n${i}`, { title: `英伟达第${i}条独立快讯，内容各不相同 ${i * 31}`, url: `https://e.example/${i}`, pubDate: T0 - i * 1000 })], T0 + i)
    await ingest(w, "ths", [row("other", { title: "特斯拉与英伟达无关的一条", url: "https://e.example/o" })], T0 + 100)
    const got: string[] = []
    let cursor: string | undefined
    for (;;) {
      const res = await w.service.query({ symbol: "NVDA.XNAS", source: "cls-telegraph", limit: 10, cursor })
      got.push(...res.items.map(i => i.itemId))
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }
    expect(got).toEqual(Array.from({ length: 25 }, (_, i) => `n${i}`))
    expect((await w.service.query({ symbol: "NVDA.XNAS", q: "第7条" })).items.map(i => i.itemId)).toEqual(["n7"])
  })
})

describe("回填与失败", () => {
  it("富化抛错不影响入库：条目留 enriched = 0，回填补上，结果与实时富化一致", async () => {
    const live = await world()
    await three(live)
    const w = await feedWorld(DESCS(), { enrich: false })
    const failing = createEnricher(w.db)
    const original = failing.store.save.bind(failing.store)
    let broken = true
    failing.store.save = async (...args) => {
      if (broken) throw new Error("disk full")
      return original(...args)
    }
    w.store.setEnricher(failing)
    vi.spyOn(logger, "warn").mockImplementation(() => {})
    await three(w)
    expect((await w.service.query({})).items).toHaveLength(3) // 入库成功，只是没分组
    expect((await failing.store.counts()).pending).toBe(3)
    broken = false
    expect(await failing.backfill(2)).toBe(3)
    expect((await failing.store.counts()).pending).toBe(0)
    const norm = (r: Awaited<ReturnType<typeof live.service.query>>) => r.items.map(i => [i.itemId, i.cleanTitle, i.sourcesCount, i.members.map(m => m.itemId)])
    expect(norm(await w.service.query({}))).toEqual(norm(await live.service.query({})))
    vi.restoreAllMocks()
  })

  it("回填按 seq 顺序、规则与实时一样；重复跑不改任何东西", async () => {
    const w = await feedWorld(undefined, { enrich: false })
    await ingest(w, "jin10", [row("a", { title: "贵州茅台公告回购股份，涨停了，市场反应热烈", url: null })], T0)
    await ingest(w, "weibo", [row("b", { title: "贵州茅台公告回购股份，涨停了，市场反应热烈", url: null })], T0 + 1000)
    expect(await w.enricher.backfill()).toBe(2)
    const snapshot = async () => (await w.db.prepare(`SELECT seq, dup_of, enriched, clean_title, canon_url, title_key FROM items ORDER BY seq`).all()) as any[]
    const once = await snapshot()
    expect(once.map(r => [r.seq, r.dup_of, r.enriched])).toEqual([[1, null, ENRICH_VERSION], [2, 1, ENRICH_VERSION]])
    expect(await w.enricher.backfill()).toBe(0)
    expect(await snapshot()).toEqual(once)
  })

  it("重算标的（词典更新后）：只改清洗标题与标的，不动分组", async () => {
    const w = await world()
    await three(w)
    await w.db.prepare(`DELETE FROM item_symbols`).run()
    await ingest(w, "ths", [row("q", { title: "英伟达（NVDA.O）盘前涨超3%，市场关注财报", url: null })], T0 + 5000)
    const groups = async () => (await w.db.prepare(`SELECT seq, dup_of FROM items ORDER BY seq`).all()) as any[]
    const before = await groups()
    expect(await w.enricher.resymbol(2)).toBe(4)
    expect(await groups()).toEqual(before)
    expect((await w.service.query({ symbol: "NVDA.XNAS" })).items.map(i => i.itemId)).toEqual(["q"])
  })
})

describe("迁移", () => {
  it("旧库（没有富化的列）升级：补列、不丢数据、旧条目 enriched = 0 且照常出现在默认流里", async () => {
    const db = createDatabase(sqlite({ name: ":memory:" }))
    await db.prepare(`
      CREATE TABLE items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
        pub_date INTEGER, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, feed_ts INTEGER NOT NULL, UNIQUE (source_id, item_id))
    `).run()
    await db.prepare(`INSERT INTO items (source_id, item_id, title, url, pub_date, first_seen_at, last_seen_at, feed_ts) VALUES ('jin10', 'old', '旧条目', null, null, 1, 1, 1)`).run()
    const store = new ObservationStore(db)
    await store.init()
    await store.init() // 重复 init 不报错
    const row0 = await db.prepare(`SELECT seq, title, enriched, dup_of, clean_title FROM items`).get() as any
    expect(row0).toMatchObject({ seq: 1, title: "旧条目", enriched: 0, dup_of: null, clean_title: null })
  })

  it("两个进程同时首次迁移：后一个撞上 duplicate column 也算成功", async () => {
    const db = createDatabase(sqlite({ name: ":memory:" }))
    await db.prepare(`
      CREATE TABLE items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
        pub_date INTEGER, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, feed_ts INTEGER NOT NULL, UNIQUE (source_id, item_id))
    `).run()
    const a = new ObservationStore(db)
    const b = new ObservationStore(db)
    await expect(Promise.all([a.init(), b.init()])).resolves.toBeDefined()
    const columns = ((await db.prepare(`PRAGMA table_info(items)`).all()) as any[]).map(c => c.name)
    expect(columns).toEqual(expect.arrayContaining(["clean_title", "orig_url", "canon_url", "title_key", "dup_of", "enriched"]))
  })
})
