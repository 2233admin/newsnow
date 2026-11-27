import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { describe, expect, it } from "vitest"
import { T0, descriptors, feedWorld, ingest, keyOf, row } from "../feed/helpers"
import { ObservationStore } from "#/collector/store"
import { createEnricher } from "#/enrich/enrich"
import { createFeedService } from "#/feed/service"
import { FeedStore } from "#/feed/store"
import { normalizeFeedParams } from "#/feed/params"
import { MAX_TAG_ATTEMPTS, createTagger } from "#/enrich/tagger"
import type { LlmCall } from "#/enrich/llm"
import { InputError } from "#/registry/spec"

const bj = (iso: string) => Date.parse(`${iso}+08:00`)
const ny = (iso: string, offset: string) => Date.parse(`${iso}${offset}`)
const world = () => feedWorld(descriptors([{ id: "cls-telegraph", name: "财联社电报", category: "finance", builtin: true, enabled: true }]), { enrich: true })
const t = (n: number, extra = "") => `第${n}条互不相同的测试快讯：${"甲乙丙丁戊己庚辛壬癸"[n % 10]}${n * 7919}号事项发布公告 ${extra}`

describe("对齐交易日：写库时算好，查询带 align 并可按 tradeDate / market 筛", () => {
  async function seeded() {
    const w = await world()
    await ingest(w, "jin10", [row("fri-post", { title: t(1) })], bj("2026-11-27T15:01:00")) // 周五 15:01 → 周一，post
    await ingest(w, "jin10", [row("sat", { title: t(2) })], bj("2026-11-28T10:00:00")) // 周六 → 周一，closed
    await ingest(w, "jin10", [row("mon-open", { title: t(3) })], bj("2026-11-30T10:00:00")) // 周一盘中 → 周一，open
    await ingest(w, "jin10", [row("tue", { title: t(4) })], bj("2026-12-01T10:00:00")) // 周二 → 周二
    await ingest(w, "jin10", [row("aapl", { title: "苹果（AAPL）发布新品，供应链订单增加，市场关注度很高" })], ny("2026-11-30T10:00:00", "-05:00")) // 美股周一盘中（北京时间 23:00）
    await ingest(w, "jin10", [row("btc", { title: "比特币（BTC）突破新高，链上活跃地址数量明显增加" })], Date.UTC(2026, 10, 29, 23, 59)) // 周日 UTC 23:59
    return w
  }

  it("每条带 align：15:01 的 A 股公告 tradeDate 是下一个交易日、session = post；周六的归下周一、session = closed", async () => {
    const w = await seeded()
    const { items } = await w.service.query({ includeInactive: "1", limit: "50" })
    const by = new Map(items.map(i => [i.itemId, i]))
    expect(by.get("fri-post")!.align).toEqual([{ market: "cn", tradeDate: "2026-11-30", session: "post" }])
    expect(by.get("sat")!.align).toEqual([{ market: "cn", tradeDate: "2026-11-30", session: "closed" }])
    expect(by.get("mon-open")!.align).toEqual([{ market: "cn", tradeDate: "2026-11-30", session: "open" }])
    expect(by.get("aapl")!.align).toEqual([{ market: "us", tradeDate: "2026-11-30", session: "open" }])
    expect(by.get("btc")!.align).toEqual([{ market: "crypto", tradeDate: "2026-11-29", session: "open" }])
  })

  it("tradeDate + market：这个市场的这个交易日", async () => {
    const w = await seeded()
    const ids = async (q: Record<string, unknown>) => (await w.service.query({ includeInactive: "1", ...q })).items.map(i => i.itemId).sort()
    expect(await ids({ market: "cn", tradeDate: "2026-11-30" })).toEqual(["fri-post", "mon-open", "sat"])
    expect(await ids({ market: "cn", tradeDate: "2026-12-01" })).toEqual(["tue"])
    expect(await ids({ market: "us", tradeDate: "2026-11-30" })).toEqual(["aapl"])
    expect(await ids({ market: "crypto", tradeDate: "2026-11-29" })).toEqual(["btc"])
    expect(await ids({ market: "us", tradeDate: "2026-12-01" })).toEqual([])
  })

  it("只给 tradeDate：任一市场对齐到这天的；只给 market：对齐过这个市场的", async () => {
    const w = await seeded()
    const ids = async (q: Record<string, unknown>) => (await w.service.query({ includeInactive: "1", ...q })).items.map(i => i.itemId).sort()
    expect(await ids({ tradeDate: "2026-11-30" })).toEqual(["aapl", "fri-post", "mon-open", "sat"])
    expect(await ids({ market: "us" })).toEqual(["aapl"])
    expect(await ids({ market: "cn" })).toEqual(["fri-post", "mon-open", "sat", "tue"])
  })

  it("默认按组收拢时：成员落在这个交易日、主条目不在，代表行是范围内最早的成员（同来源范围的规则）", async () => {
    const w = await world()
    const T = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
    await ingest(w, "jin10", [row("main", { title: T, url: "https://a.example/1" })], bj("2026-11-27T10:00:00")) // 周五盘中 → 11-27
    await ingest(w, "weibo", [row("late", { title: `${T}。`, url: "https://a.example/2" })], bj("2026-11-28T10:00:00")) // 周六（休市）→ 周一 11-30；与主条目相隔 24 小时，在去重窗口内
    const mon = await w.service.query({ market: "cn", tradeDate: "2026-11-30" })
    expect(mon.items.map(keyOf)).toEqual(["weibo/late"])
    expect(mon.items[0].groupId).toBe(1) // 组还是主条目那一组
    const fri = await w.service.query({ market: "cn", tradeDate: "2026-11-27" })
    expect(fri.items.map(keyOf)).toEqual(["jin10/main"])
  })

  it("对齐的参数校验：日期要真实存在，market 与 direction 在枚举里", () => {
    expect(normalizeFeedParams({ tradeDate: "2026-11-30", market: "CN" })).toMatchObject({ tradeDate: "2026-11-30", market: "cn" })
    for (const bad of [{ tradeDate: "2026-02-30" }, { tradeDate: "20261130" }, { tradeDate: "明天" }, { market: "hk" }, { direction: "up" }]) {
      expect(() => normalizeFeedParams(bad), JSON.stringify(bad)).toThrow(InputError)
    }
  })
})

describe("规则层：被过滤的仍入库、默认查不出、可按参数查回", () => {
  it("软文默认不出；includeFiltered 查回并带 filterReason；库里仍有这一行", async () => {
    const w = await world()
    await ingest(w, "jin10", [row("ok", { title: "贵州茅台：控股股东拟增持不低于 1 亿元，彰显长期发展信心" }), row("spam", { title: "加微信领取今日牛股名单，限时免费，明日必涨停" }), row("rank", { title: "本周涨幅榜前十，第一名翻了三倍，你买到了吗" })], T0)
    expect((await w.service.query({})).items.map(i => i.itemId)).toEqual(["ok"])
    const all = await w.service.query({ includeFiltered: "1" })
    expect(all.items.map(i => [i.itemId, i.filterReason])).toEqual([["spam", "stock_tout"], ["rank", "ranking_list"], ["ok", null]])
    expect((await w.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(3)
  })

  it("过滤是范围条件：主条目被过滤、后到的成员正常 → 默认流里由那个成员代表这一组", async () => {
    const w = await world()
    await ingest(w, "jin10", [row("a", { title: "加微信领取今日牛股名单，限时免费，明日必涨停", url: "https://x.example/same?utm_source=x" })], T0)
    await ingest(w, "weibo", [row("b", { title: "某公司发布重大合同公告，金额超过去年营收的一半", url: "https://x.example/same" })], T0 + 1000)
    const res = await w.service.query({})
    expect(res.items.map(keyOf)).toEqual(["weibo/b"])
    expect(res.items[0]).toMatchObject({ groupId: 1, sourcesCount: 2, filterReason: null })
    const all = await w.service.query({ includeFiltered: "1" })
    expect(all.items.map(keyOf)).toEqual(["jin10/a"]) // 全部放开时代表行回到主条目
  })

  it("展开模式同样按行过滤", async () => {
    const w = await world()
    await ingest(w, "jin10", [row("ok", { title: "贵州茅台：控股股东拟增持不低于 1 亿元，彰显长期发展信心" }), row("spam", { title: "【广告】某某证券开户福利，万一免五，限时开放" })], T0)
    expect((await w.service.query({ expand: "1" })).items.map(i => i.itemId)).toEqual(["ok"])
    expect((await w.service.query({ expand: "1", includeFiltered: "1" })).items.map(i => i.itemId)).toEqual(["spam", "ok"])
  })

  it("实时流默认不推被过滤的，includeFiltered=1 才推", async () => {
    const { openFeedStream } = await import("#/feed/stream")
    const w = await world()
    const open = async (q: Record<string, unknown>) => {
      const ev: any[] = []
      const h = openFeedStream({ store: w.store, feed: w.feedStore, describe: async () => w.state.descs }, normalizeFeedParams(q), undefined, e => ev.push(e))
      await h.ready
      return { ev, items: () => ev.filter(e => e.type === "item").map(e => e.item.itemId) }
    }
    const a = await open({})
    const b = await open({ includeFiltered: "1" })
    await ingest(w, "jin10", [row("ok", { title: "贵州茅台：控股股东拟增持不低于 1 亿元，彰显长期发展信心" }), row("spam", { title: "加微信领取今日牛股名单，限时免费，明日必涨停" })], T0)
    const { vi } = await import("vitest")
    await vi.waitFor(() => expect(b.items()).toEqual(["ok", "spam"]))
    expect(a.items()).toEqual(["ok"])
    // 推出的条目带 align / tags / filterReason
    expect(b.ev.find(e => e.type === "item" && e.item.itemId === "spam").item).toMatchObject({ filterReason: "stock_tout", tags: null, align: [{ market: "cn" }] })
  })
})

describe("影响类型与方向的筛选（标注挂在组上，按组判断）", () => {
  const llm: LlmCall = async (req) => {
    const n = (req.user.match(/^\[\d+\]/gm) ?? []).length
    // 按标题里的关键字给类型与方向，便于断言
    const lines = req.user.split("\n").filter(l => /^\[\d+\]/.test(l))
    return JSON.stringify(Array.from({ length: n }, (_, i) => {
      const line = lines[i]
      return line.includes("增持") ? { i, t: "公告", d: "+", g: "增持", k: ["白酒"] } : line.includes("处罚") ? { i, t: "政策与监管", d: "-", g: "处罚", k: [] } : { i, t: "市场情绪", d: "0", g: "情绪", k: [] }
    }))
  }
  async function tagged() {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("up", { title: "贵州茅台：控股股东拟增持不低于 1 亿元，彰显长期发展信心", url: "https://x.example/up" }), row("pen", { title: "证监会对某上市公司信息披露违规作出行政处罚，罚款三百万元", url: "https://x.example/pen" }), row("mood", { title: "午后两市震荡走高，成交额放大，板块轮动明显加快", url: "https://x.example/mood" })], T0)
    // 增持那条被另一个来源转载：成员行
    await ingest(w, "jin10", [row("up2", { title: "贵州茅台：控股股东拟增持不低于 1 亿元，彰显长期发展信心。", url: "https://x.example/up2" })], T0 + 1000)
    await createTagger({ store: w.enricher.store, llm, sourceIds: async () => null }).run()
    return w
  }

  it("impact：命中的组出一行（来源数含转载）；多个值取并集；不在表里的值查不到", async () => {
    const w = await tagged()
    const ids = async (q: Record<string, unknown>) => (await w.service.query(q)).items.map(i => i.itemId).sort()
    expect(await ids({ impact: "公告" })).toEqual(["up"])
    expect(await ids({ impact: "政策与监管" })).toEqual(["pen"])
    expect(await ids({ impact: "公告,政策与监管" })).toEqual(["pen", "up"])
    expect(await ids({ impact: ["公告", "市场情绪"] })).toEqual(["mood", "up"])
    expect(await ids({ impact: "没有这一类" })).toEqual([])
    const up = (await w.service.query({ impact: "公告" })).items[0]
    expect(up).toMatchObject({ sourcesCount: 2, tags: { impact: "公告", direction: "positive", gist: "增持", themes: ["白酒"] } })
  })

  it("direction：positive / negative / neutral；与 impact 组合是交集", async () => {
    const w = await tagged()
    const ids = async (q: Record<string, unknown>) => (await w.service.query(q)).items.map(i => i.itemId).sort()
    expect(await ids({ direction: "positive" })).toEqual(["up"])
    expect(await ids({ direction: "negative" })).toEqual(["pen"])
    expect(await ids({ direction: "neutral" })).toEqual(["mood"])
    expect(await ids({ direction: "positive,negative" })).toEqual(["pen", "up"])
    expect(await ids({ impact: "公告", direction: "negative" })).toEqual([])
    expect(await ids({ impact: "公告", direction: "positive" })).toEqual(["up"])
  })

  it("展开模式下按组判断：成员行也跟着主条目命中，且成员行 tags 是主条目的", async () => {
    const w = await tagged()
    const res = await w.service.query({ impact: "公告", expand: "1" })
    expect(res.items.map(i => i.itemId).sort()).toEqual(["up", "up2"])
    for (const i of res.items) expect(i.tags).toMatchObject({ impact: "公告" })
  })

  it("没标过的组不会被 impact / direction 命中；不带这两个条件时 tags 是 null", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("x", { title: t(9) })], T0)
    expect((await w.service.query({ impact: "公告" })).items).toEqual([])
    expect((await w.service.query({})).items[0].tags).toBeNull()
  })

  it("与来源、关键词、时间范围、tradeDate 组合", async () => {
    const w = await tagged()
    expect((await w.service.query({ impact: "公告", source: "cls-telegraph" })).items.map(i => i.itemId)).toEqual(["up"])
    expect((await w.service.query({ impact: "公告", source: "jin10" })).items.map(i => i.itemId)).toEqual(["up2"]) // 只看 jin10 时，转载那条代表这一组，标注仍是主条目的
    expect((await w.service.query({ impact: "公告", q: "增持" })).items).toHaveLength(1)
    expect((await w.service.query({ impact: "公告", q: "处罚" })).items).toHaveLength(0)
    expect((await w.service.query({ impact: "公告", market: "cn", tradeDate: "2026-11-23" })).items).toHaveLength(1) // T0 是周六，归周一 11-23
    expect((await w.service.query({ impact: "公告", market: "us", tradeDate: "2026-11-23" })).items).toHaveLength(0)
  })

  it("feed meta：给出各市场的分类表、方向、时段、过滤原因与模型是否配置", async () => {
    const w = await world()
    const meta = w.service.meta()
    expect(meta.markets.find(m => m.id === "cn")!.impactTypes.map(x => x.name)).toContain("政策与监管")
    expect(meta.directions).toEqual(["positive", "negative", "neutral"])
    expect(meta.sessions).toEqual(["pre", "open", "lunch", "post", "closed"])
    expect(meta.filterReasons.map(f => f.id)).toEqual(["advert", "stock_tout", "ranking_list", "market_roundup"])
    expect(meta.tagging.configured).toBe(false)
  })
})

describe("迁移与回填", () => {
  it("存量库（没有新列、新表）启动时补上列与表，旧行保持原样、tags 与 align 为空；查询照常", async () => {
    const db = createDatabase(sqlite({ name: ":memory:" }))
    // #2188 第一版的 items 表（有富化列，没有分类标注列）
    await db.exec(`CREATE TABLE items (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT, pub_date INTEGER,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, feed_ts INTEGER NOT NULL,
      clean_title TEXT, orig_url TEXT, canon_url TEXT, title_key TEXT, dup_of INTEGER, enriched INTEGER NOT NULL DEFAULT 0, UNIQUE (source_id, item_id))`)
    await db.exec(`INSERT INTO items (source_id, item_id, title, first_seen_at, last_seen_at, feed_ts, clean_title, enriched) VALUES ('jin10', 'old', '旧条目：存量数据', ${T0}, ${T0}, ${T0}, '旧条目：存量数据', 1)`)
    await new ObservationStore(db).init()
    await new ObservationStore(db).init() // 重复启动也行
    const cols = ((await db.prepare("PRAGMA table_info(items)").all()) as { name: string }[]).map(c => c.name)
    for (const c of ["filter_reason", "impact", "direction", "gist", "themes", "tagged", "tag_attempts"]) expect(cols).toContain(c)
    const service = createFeedService({ store: new FeedStore(db), describe: async () => descriptors(), clock: () => T0 })
    const res = await service.query({})
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({ itemId: "old", tags: null, filterReason: null, align: [] })
  })

  it("direction 改名：库里已标的 bull / bear 启动时改成 positive / negative，可重复启动；查询里旧值被拒绝", async () => {
    const db = createDatabase(sqlite({ name: ":memory:" }))
    await new ObservationStore(db).init()
    await db.exec(`INSERT INTO items (source_id, item_id, title, first_seen_at, last_seen_at, feed_ts, clean_title, enriched, impact, direction, tagged) VALUES
      ('jin10', 'a', '旧标注甲', ${T0}, ${T0}, ${T0}, '旧标注甲', 2, '公告', 'bull', 1),
      ('jin10', 'b', '旧标注乙', ${T0}, ${T0}, ${T0 + 1}, '旧标注乙', 2, '公告', 'bear', 1),
      ('jin10', 'c', '旧标注丙', ${T0}, ${T0}, ${T0 + 2}, '旧标注丙', 2, '公告', 'neutral', 1)`)
    await new ObservationStore(db).init()
    await new ObservationStore(db).init()
    const rows = (await db.prepare("SELECT item_id AS id, direction AS d FROM items ORDER BY seq").all()) as { id: string, d: string }[]
    expect(rows).toEqual([{ id: "a", d: "positive" }, { id: "b", d: "negative" }, { id: "c", d: "neutral" }])
    expect(() => normalizeFeedParams({ direction: "bull" })).toThrow(InputError)
    expect(() => normalizeFeedParams({ direction: "bear" })).toThrow(InputError)
  })

  it("enrich:backfill --rules：给版本 1 的存量条目补过滤原因与对齐，可重复跑；--all 全部重算", async () => {
    const w = await world()
    await ingest(w, "jin10", [row("a", { title: t(1) }), row("b", { title: "加微信领取今日牛股名单，限时免费，明日必涨停" }), row("c", { title: t(3) })], bj("2026-11-27T15:01:00"))
    // 退回「版本 1」的样子：没有过滤原因、没有对齐
    await w.db.exec(`UPDATE items SET enriched = 1, filter_reason = NULL`)
    await w.db.exec(`DELETE FROM item_align`)
    expect((await w.service.query({ market: "cn", tradeDate: "2026-11-30" })).items).toHaveLength(0)
    expect(await w.enricher.reapplyRules(2)).toBe(3) // 小批量，覆盖分批
    expect((await w.service.query({ market: "cn", tradeDate: "2026-11-30" })).items.map(i => i.itemId).sort()).toEqual(["a", "c"])
    expect((await w.service.query({ includeFiltered: "1" })).items.find(i => i.itemId === "b")!.filterReason).toBe("stock_tout")
    expect(((await w.db.prepare("SELECT DISTINCT enriched AS e FROM items").all()) as { e: number }[]).map(r => r.e)).toEqual([2])
    expect(await w.enricher.reapplyRules()).toBe(0) // 已是当前版本，不重复处理
    expect(await w.enricher.reapplyRules(500, undefined, true)).toBe(3)
  })

  it("补算不动分组与标题：并成一组的条目仍是一组", async () => {
    const w = await world()
    const T = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
    await ingest(w, "jin10", [row("a", { title: T, url: "https://a.example/1" })], T0)
    await ingest(w, "weibo", [row("b", { title: `${T}。`, url: "https://a.example/2" })], T0 + 1000)
    await w.db.exec(`UPDATE items SET enriched = 1`)
    await w.enricher.reapplyRules()
    const res = await w.service.query({})
    expect(res.items).toHaveLength(1)
    expect(res.items[0].sourcesCount).toBe(2)
  })
})

describe("d1 的 100 个绑定参数上限", () => {
  it("一批 150 条入库 + 富化 + 标注 + 各种筛选查询，没有一条语句的绑定参数超过 100", async () => {
    const db = createDatabase(sqlite({ name: ":memory:" }))
    let max = 0
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      const st = prepare(sql) as any
      for (const m of ["run", "all", "get"] as const) {
        const orig = st[m].bind(st)
        st[m] = (...args: unknown[]) => {
          max = Math.max(max, args.length)
          return orig(...args)
        }
      }
      return st
    }) as typeof db.prepare
    const store = new ObservationStore(db)
    await store.init()
    const enricher = createEnricher(db)
    store.setEnricher(enricher)
    const feedStore = new FeedStore(db)
    const service = createFeedService({ store: feedStore, describe: async () => descriptors(), clock: () => T0 })
    const rows = Array.from({ length: 150 }, (_, i) => row(`n${i}`, { title: `第${i}号：${"甲乙丙丁戊己庚辛壬癸"[i % 10]}${i * 104729}事项发布了一则内容互不相同的测试快讯`, url: `https://x.example/${i}` }))
    await store.recordObservations("jin10", rows, bj("2026-11-30T10:00:00"))
    expect((await service.query({ limit: "200" })).items).toHaveLength(150)
    const llm: LlmCall = async req => JSON.stringify(Array.from({ length: (req.user.match(/^\[\d+\]/gm) ?? []).length }, (_, i) => ({ i, t: "公告", d: "+", g: "g", k: ["x"] })))
    const tagger = createTagger({ store: enricher.store, llm, sourceIds: async () => null, batchSize: 150 })
    expect(await tagger.run(1)).toMatchObject({ tagged: 150 })
    await service.query({ impact: "公告", direction: "positive", market: "cn", tradeDate: "2026-11-30", includeFiltered: "1", limit: "200", q: "测试", source: "jin10" })
    await enricher.reapplyRules(150, undefined, true)
    await enricher.resymbol(150)
    expect(max).toBeGreaterThan(50) // 确实走了多行语句
    expect(max).toBeLessThanOrEqual(100)
    expect(MAX_TAG_ATTEMPTS).toBeGreaterThan(0)
  })
})
