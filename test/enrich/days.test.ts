import { describe, expect, it } from "vitest"
import { descriptors, feedWorld, ingest, pageAll, promptItems, row } from "../feed/helpers"
import type { LlmCall } from "#/enrich/llm"
import { createTagger } from "#/enrich/tagger"
import { MAX_DAYS_SPAN } from "#/feed/service"
import { assertStreamParams, normalizeFeedParams } from "#/feed/params"
import { InputError } from "#/registry/spec"

const bj = (iso: string) => Date.parse(`${iso}+08:00`)
const world = () => feedWorld(descriptors([{ id: "cls-telegraph", name: "财联社电报", category: "finance", builtin: true, enabled: true }]), { enrich: true })

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("独立审 M5：只给 symbol + tradeDate、没给 market：按标的所属市场限定", () => {
  async function both() {
    const w = await world()
    // 同时点到 A 股与美股标的；北京时间周一 16:00：A 股已收盘 → 12-01，美股此时（周一凌晨 03:00 ET）盘前 → 11-30
    await ingest(w, "jin10", [row("both", { title: "苹果（AAPL）与贵州茅台（600519）同日披露三季报，市场高度关注两家公司业绩" })], bj("2026-11-30T16:00:00"))
    return w
  }
  const ids = async (w: Awaited<ReturnType<typeof both>>, q: Record<string, unknown>) => (await w.service.query({ includeInactive: "1", ...q })).items.map(i => i.itemId)

  it("前提：这条新闻对齐 cn → 2026-12-01、us → 2026-11-30", async () => {
    const w = await both()
    const one = (await w.service.query({ includeInactive: "1" })).items[0]
    expect(one.symbols.sort()).toEqual(["600519.XSHG", "AAPL.XNAS"])
    expect(one.align).toEqual([{ market: "cn", tradeDate: "2026-12-01", session: "post" }, { market: "us", tradeDate: "2026-11-30", session: "pre" }])
  })

  it("aAPL 在 12-01 没有新闻（它对齐的是 11-30）；茅台在 11-30 没有（它对齐的是 12-01）", async () => {
    const w = await both()
    expect(await ids(w, { symbol: "AAPL.XNAS", tradeDate: "2026-12-01" })).toEqual([])
    expect(await ids(w, { symbol: "AAPL.XNAS", tradeDate: "2026-11-30" })).toEqual(["both"])
    expect(await ids(w, { symbol: "600519.XSHG", tradeDate: "2026-11-30" })).toEqual([])
    expect(await ids(w, { symbol: "600519.XSHG", tradeDate: "2026-12-01" })).toEqual(["both"])
  })

  it("区间同理；显式的 market 优先；只给 symbol 不给交易日条件时不推（行为不变）", async () => {
    const w = await both()
    expect(await ids(w, { symbol: "AAPL.XNAS", tradeDateFrom: "2026-12-01", tradeDateTo: "2026-12-31" })).toEqual([])
    expect(await ids(w, { symbol: "AAPL.XNAS", tradeDateFrom: "2026-11-01", tradeDateTo: "2026-11-30" })).toEqual(["both"])
    expect(await ids(w, { symbol: "AAPL.XNAS", market: "cn", tradeDate: "2026-12-01" })).toEqual(["both"]) // 显式的 cn：自己负责
    expect(await ids(w, { symbol: "AAPL.XNAS" })).toEqual(["both"])
    expect(normalizeFeedParams({ symbol: "AAPL.XNAS" }).market).toBeUndefined()
    expect(normalizeFeedParams({ symbol: "AAPL.XNAS", tradeDate: "2026-11-30" }).market).toBe("us")
    expect(normalizeFeedParams({ symbol: "BTCUSDT.BINANCE", tradeDateFrom: "2026-11-30" }).market).toBe("crypto")
    expect(normalizeFeedParams({ symbol: "000001.XSHE,600519.XSHG", tradeDate: "2026-11-30" }).market).toBe("cn")
  })

  it("symbol 跨了多个市场又没给 market：400，不猜；场所不认识：不推", async () => {
    expect(() => normalizeFeedParams({ symbol: "AAPL.XNAS,600519.XSHG", tradeDate: "2026-11-30" })).toThrow(InputError)
    expect(normalizeFeedParams({ symbol: "AAPL.XNAS,600519.XSHG", market: "us", tradeDate: "2026-11-30" }).market).toBe("us")
    expect(normalizeFeedParams({ symbol: "0700.XHKG", tradeDate: "2026-11-30" }).market).toBeUndefined()
  })
})

describe("独立审 M6：tradeDateFrom / tradeDateTo", () => {
  it("区间含端点、按对齐的交易日算：周末与收盘后的新闻按顺延后的交易日落进区间，不是按发布时间戳", async () => {
    const w = await world()
    await ingest(w, "jin10", [row("fri-post", { title: "周五收盘后发布的公告一：某公司披露回购方案，金额上限两亿元，期限十二个月" })], bj("2026-11-27T15:01:00")) // → 11-30
    await ingest(w, "jin10", [row("sat", { title: "周六发布的公告二：某公司披露对外投资事项，投资金额一点五亿元，预计年内完成" })], bj("2026-11-28T10:00:00")) // → 11-30
    await ingest(w, "jin10", [row("mon", { title: "周一盘中发布的公告三：某公司披露重大合同中标，合同总金额约三亿元，履行期三年" })], bj("2026-11-30T10:00:00")) // 11-30
    await ingest(w, "jin10", [row("tue", { title: "周二盘中发布的公告四：某公司披露高管变动，董事长因个人原因辞职，由总经理代行职责" })], bj("2026-12-01T10:00:00")) // 12-01
    const ids = async (q: Record<string, unknown>) => (await w.service.query({ includeInactive: "1", market: "cn", ...q })).items.map(i => i.itemId).sort()
    expect(await ids({ tradeDateFrom: "2026-11-30", tradeDateTo: "2026-11-30" })).toEqual(["fri-post", "mon", "sat"])
    expect(await ids({ tradeDateFrom: "2026-11-30", tradeDateTo: "2026-12-01" })).toEqual(["fri-post", "mon", "sat", "tue"])
    expect(await ids({ tradeDateFrom: "2026-12-01" })).toEqual(["tue"])
    expect(await ids({ tradeDateTo: "2026-11-29" })).toEqual([])
    // 用 from / to（feed_ts）框同一个范围对不上：周五 15:01 与周六的新闻时间戳在 11-30 之前——这就是要有 tradeDateFrom / To 的原因
    const byTs = (await w.service.query({ includeInactive: "1", market: "cn", from: String(bj("2026-11-30T00:00:00")), to: String(bj("2026-12-01T00:00:00")) })).items.map(i => i.itemId).sort()
    expect(byTs).toEqual(["mon"])
  })

  it("参数校验：日期要真实存在、起点不晚于终点", () => {
    expect(normalizeFeedParams({ tradeDateFrom: "2026-11-01", tradeDateTo: "2026-11-30" })).toMatchObject({ tradeDateFrom: "2026-11-01", tradeDateTo: "2026-11-30" })
    for (const bad of [{ tradeDateFrom: "2026-02-30" }, { tradeDateTo: "11-30" }, { tradeDateFrom: "2026-12-01", tradeDateTo: "2026-11-01" }]) {
      expect(() => normalizeFeedParams(bad), JSON.stringify(bad)).toThrow(InputError)
    }
  })
})

describe("独立审 M6：GET /api/feed/days 与 GET /api/feed 的口径一致", () => {
  /** 造一个有转载组、过滤条目、两个市场的标的、标注的库，时间跨周末与收盘后。 */
  async function seeded() {
    const w = await world()
    const rnd = mulberry32(2188)
    const sources = ["jin10", "weibo", "cls-telegraph", "hackernews"]
    const llm: LlmCall = async (req) => {
      return JSON.stringify(promptItems(req.user).map(({ id, title: text }) => {
        const h = [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
        return { id, t: ["公告", "政策与监管", "市场情绪", "行业与题材"][h % 4], d: ["+", "-", "0"][h % 3], g: "要点", k: [h % 2 ? "白酒" : "芯片"] }
      }))
    }
    const base = bj("2026-11-23T08:00:00") // 周一
    for (let n = 0; n < 70; n++) {
      const prefix = n % 5 === 0 ? "贵州茅台：" : n % 7 === 0 ? "苹果（AAPL）：" : n % 11 === 0 ? "苹果（AAPL）与贵州茅台：" : ""
      const body = `${prefix}第${n}号事项${"甲乙丙丁戊己庚辛壬癸"[n % 10]}${n * 7919}发布进展通报，涉及${["回购", "增持", "处罚", "业绩", "合作", "减持"][n % 6]}安排`
      const title = n % 13 === 12 ? "加微信领取今日牛股名单，限时免费，明日必涨停，机会难得" : body
      const copies = 1 + Math.floor(rnd() * 3) // 1–3 个来源转载同一条
      for (let c = 0; c < copies; c++) {
        // 转载落在原时间之后的 0–40 小时内（跨天、跨周末，成员可能落在不同的交易日）；去重窗口内的才并组
        const at = base + Math.floor(n * 3.1 * 3600_000 % (9 * 86_400_000)) + c * Math.floor(rnd() * 40 * 3600_000)
        const source = sources[(n + c) % sources.length]
        await ingest(w, source, [row(`n${n}-${c}`, { title: c ? `${title}。` : title, url: `https://x.example/${n}${c ? `/${c}` : ""}` })], at)
      }
    }
    await createTagger({ store: w.enricher.store, llm, sourceIds: async () => null, batchSize: 40, maxBatchesPerRun: 50 }).run()
    // 标注真的写进去了（不是整批没标上、让「类型与方向分布一致」的断言空转）
    const counts = await w.enricher.store.tagCounts(3)
    expect(counts.tagged).toBeGreaterThan(30)
    expect(counts.pending).toBe(0)
    return w
  }

  const dates = (from: string, to: string) => {
    const out: string[] = []
    for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10))
    return out
  }

  const combos: [string, Record<string, unknown>][] = [
    ["默认", {}],
    ["expand", { expand: "1" }],
    ["标的 600519", { symbol: "600519.XSHG" }],
    ["标的 + expand", { symbol: "600519.XSHG", expand: "1" }],
    ["影响类型", { impact: "公告,市场情绪" }],
    ["方向", { direction: "negative" }],
    ["影响类型 + 方向 + 标的", { impact: "公告", direction: "positive,neutral", symbol: "600519.XSHG,000001.XSHE" }],
    ["来源范围", { source: "jin10,weibo" }],
    ["分类", { category: "finance" }],
    ["关键词", { q: "回购" }],
    ["含过滤的", { includeFiltered: "1" }],
    ["发布时间范围", { from: String(bj("2026-11-24T00:00:00")), to: String(bj("2026-11-29T00:00:00")) }],
  ]

  for (const market of ["cn", "us"] as const) {
    it(`每个交易日的 count = /api/feed 同样参数加 tradeDate 的总条数（逐日、逐种筛选；市场 ${market}）；类型与方向分布一致`, async () => {
      const w = await seeded()
      const from = "2026-11-20"
      const to = "2026-12-10"
      let nonEmptyDays = 0
      let multiMember = 0
      for (const [label, extra] of combos) {
        const res = await w.service.days({ market, tradeDateFrom: from, tradeDateTo: to, ...extra })
        expect(res).toMatchObject({ market, tradeDateFrom: from, tradeDateTo: to })
        const byDay = new Map(res.days.map(d => [d.tradeDate, d]))
        expect(res.days.map(d => d.tradeDate)).toEqual([...byDay.keys()].sort())
        for (const d of dates(from, to)) {
          // limit = 7：逐页翻完整个结果，不让「一页装得下」掩盖口径差异
          const items = (await pageAll(w.service, { market, tradeDate: d, limit: "7", ...extra })).flatMap(p => p.items)
          const bucket = byDay.get(d)
          expect(bucket?.count ?? 0, `${label} ${market} ${d}`).toBe(items.length)
          if (!items.length) continue
          nonEmptyDays++
          multiMember += items.filter(i => i.sourcesCount > 1).length
          const tagged = items.filter(i => i.tags)
          expect(bucket!.untagged, `${label} ${d} untagged`).toBe(items.length - tagged.length)
          const tally = (pick: (i: (typeof items)[number]) => string | null | undefined) => {
            const t: Record<string, number> = {}
            for (const i of tagged) {
              const k = pick(i)
              if (k) t[k] = (t[k] ?? 0) + 1
            }
            return t
          }
          expect(bucket!.byImpact, `${label} ${d} byImpact`).toEqual(tally(i => i.tags!.impact))
          expect(bucket!.byDirection, `${label} ${d} byDirection`).toEqual(tally(i => i.tags!.direction))
        }
      }
      // 数据集本身要有料：不是一堆空日子，也确实有转载组参与
      expect(nonEmptyDays).toBeGreaterThan(20)
      expect(multiMember).toBeGreaterThan(5)
    }, 60_000)
  }

  it("同一个 (market, symbol, tradeDate)：/days 的条数等于 /feed 的总条数（验收用例）", async () => {
    const w = await seeded()
    const days = await w.service.days({ market: "cn", symbol: "600519.XSHG", tradeDateFrom: "2026-11-20", tradeDateTo: "2026-12-10" })
    expect(days.days.length).toBeGreaterThan(2)
    for (const day of days.days) {
      const feed = (await pageAll(w.service, { market: "cn", symbol: "600519.XSHG", tradeDate: day.tradeDate, limit: "5" })).flatMap(p => p.items)
      expect(day.count).toBe(feed.length)
    }
    // 不给 market、由 symbol 推出，结果一样
    expect((await w.service.days({ symbol: "600519.XSHG", tradeDateFrom: "2026-11-20", tradeDateTo: "2026-12-10" })).days).toEqual(days.days)
  })

  it("同组成员落在不同交易日：每个交易日各出一行代表行（与单独查那一天一致），不会因为区间里有更早的成员而漏掉", async () => {
    const w = await world()
    const T = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
    await ingest(w, "jin10", [row("main", { title: T, url: "https://a.example/1" })], bj("2026-11-27T10:00:00")) // 周五盘中 → 11-27
    await ingest(w, "weibo", [row("late", { title: `${T}。`, url: "https://a.example/2" })], bj("2026-11-28T10:00:00")) // 周六 → 周一 11-30，同一组
    const res = await w.service.days({ market: "cn", tradeDateFrom: "2026-11-27", tradeDateTo: "2026-11-30" })
    expect(res.days.map(d => [d.tradeDate, d.count])).toEqual([["2026-11-27", 1], ["2026-11-30", 1]])
    for (const d of ["2026-11-27", "2026-11-30"]) expect((await w.service.query({ market: "cn", tradeDate: d })).items).toHaveLength(1)
    // 区间查询里这一组只出一行（代表行是区间内最早的成员）：与按天聚合的口径不同，这正是按天各自算的原因
    expect((await w.service.query({ market: "cn", tradeDateFrom: "2026-11-27", tradeDateTo: "2026-11-30" })).items).toHaveLength(1)
    // expand：每条各算各的
    expect((await w.service.days({ market: "cn", tradeDateFrom: "2026-11-27", tradeDateTo: "2026-11-30", expand: true })).days.map(d => d.count)).toEqual([1, 1])
  })

  it("参数：要 market（或 symbol 推出）与区间；tradeDate 单日可用；区间有上限", async () => {
    const w = await seeded()
    await expect(w.service.days({ tradeDateFrom: "2026-11-20", tradeDateTo: "2026-11-30" })).rejects.toBeInstanceOf(InputError)
    await expect(w.service.days({ market: "cn" })).rejects.toBeInstanceOf(InputError)
    await expect(w.service.days({ market: "cn", tradeDateFrom: "2026-11-20" })).rejects.toBeInstanceOf(InputError)
    await expect(w.service.days({ market: "cn", tradeDateFrom: "2020-01-01", tradeDateTo: "2026-11-30" })).rejects.toThrow(String(MAX_DAYS_SPAN))
    const one = await w.service.days({ market: "cn", tradeDate: "2026-11-24" })
    expect(one).toMatchObject({ tradeDateFrom: "2026-11-24", tradeDateTo: "2026-11-24" })
    expect(one.days.length).toBeLessThanOrEqual(1)
    // 没有符合条件的来源：空，不报错
    expect((await w.service.days({ market: "cn", tradeDateFrom: "2026-11-20", tradeDateTo: "2026-12-10", source: "no-such-source" })).days).toEqual([])
  })
})

describe("独立审 S9：实时流不支持的筛选直接拒绝", () => {
  it("assertStreamParams：带了标注 / 对齐类筛选就抛 400 并点名；支持的与空值放行", () => {
    for (const k of ["market", "tradeDate", "tradeDateFrom", "tradeDateTo", "impact", "direction", "theme"]) {
      expect(() => assertStreamParams({ [k]: "x" }), k).toThrow(InputError)
      expect(() => assertStreamParams({ [k]: "x" }), k).toThrow(k)
    }
    expect(() => assertStreamParams({ impact: "公告", direction: ["positive"] })).toThrow(/impact、direction/)
    expect(() => assertStreamParams({ source: "jin10", q: "黄金", symbol: "600519.XSHG", expand: "1", includeFiltered: "1", from: "1", limit: "5" })).not.toThrow()
    expect(() => assertStreamParams({ impact: "", market: [], theme: undefined })).not.toThrow()
  })
})
