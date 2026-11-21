/**
 * 用真实的适配器（jin10 快讯、hackernews 热榜、kaopu RSS）加上录好的响应跑一遍采集器，不连网。
 * 夹具在 test/fixtures/，是 2026-11-21 对三个站点的真实响应，裁到 5–6 条。
 * 只替换 myFetch（适配器与 rss2json 的唯一出网口）；适配器的解析代码是真的。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { projectDir } from "@shared/dir"
import { createCollector } from "#/collector/collect"
import { COLLECTOR_DEFAULTS } from "#/collector/config"

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock("#/utils/fetch", () => ({ myFetch: fetchMock }))

const { default: jin10 } = await import("#/sources/jin10")
const { default: hackernews } = await import("#/sources/hackernews")
const { default: kaopu } = await import("#/sources/kaopu")
const { memoryStore } = await import("./helpers")

const fixture = (name: string) => readFileSync(join(projectDir, "test/fixtures", name), "utf8")
const MIN = 60_000
const quiet = { info: () => {}, warn: () => {} }

/** 把热榜前两条对调，模拟下一轮名次变化 */
function swapFirstTwoStories(html: string) {
  const lines = html.split("\n")
  const [head, s1, v1, s2, v2, ...rest] = lines
  return [head, s2, v2, s1, v1, ...rest].join("\n")
}

let hnPage = fixture("hackernews-front.html")
beforeEach(() => {
  hnPage = fixture("hackernews-front.html")
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string | URL) => {
    const u = String(url)
    if (u.startsWith("https://www.jin10.com/")) return fixture("jin10-flash.js")
    if (u.startsWith("https://news.ycombinator.com")) return hnPage
    if (u.startsWith("https://kaopunews.com/")) return fixture("kaopu-feed.xml")
    throw new Error(`unexpected fetch ${u}`)
  })
})

async function setup() {
  const { store, db } = await memoryStore()
  let now = Date.UTC(2026, 10, 21, 14, 0, 0)
  const collector = createCollector({
    store,
    getters: { jin10, hackernews, kaopu },
    // 间隔取真实元数据 shared/sources.json（快讯 / 热榜 / RSS 各一档）
    sources: Object.fromEntries(["jin10", "hackernews", "kaopu"].map(id => [id, { interval: sources[id as "jin10"].interval }])),
    config: { enabled: true, ...COLLECTOR_DEFAULTS },
    clock: () => now,
    log: quiet,
  })
  return { store, db, collector, advance: (ms: number) => {
    now += ms
  }, now: () => now }
}

describe("真实适配器 + 录好的响应", () => {
  it("快讯、热榜、RSS 三类源都能采进库，字段对得上", async () => {
    const { collector, store } = await setup()
    const summary = await collector.tick()

    expect(summary.failed).toEqual([])
    expect(summary.succeeded.sort()).toEqual(["hackernews", "jin10", "kaopu"])

    // 快讯：发布时间是适配器给的毫秒数（北京时间 21:29:57）
    const flash = await store.getItemHistory("jin10", "20261121212957559800")
    expect(flash?.item.pubDate).toBe(Date.UTC(2026, 10, 21, 13, 29, 57))
    expect(flash?.item.url).toBe("https://flash.jin10.com/detail/20261121212957559800")

    // 热榜：没有发布时间，入流时间是第一次出现，名次按页面顺序
    const top = await store.getItemHistory("hackernews", "50532613")
    expect(top?.item.pubDate).toBeNull()
    expect(top?.item.firstSeenAt).toBe(Date.UTC(2026, 10, 21, 14, 0, 0))
    expect(top?.observations).toEqual([{ observedAt: Date.UTC(2026, 10, 21, 14, 0, 0), rank: 1, extra: { info: "161 points" } }])

    // RSS：id 是链接，发布时间从 pubDate 字符串解析
    const health = await store.getHealth()
    expect(health.map(h => [h.sourceId, h.lastItemCount]).sort()).toEqual([["hackernews", 6], ["jin10", 5], ["kaopu", 5]])
    const feed = await store.getItemHistory("kaopu", "https://kaopu.news/story/2026-11-21/china-urges-faster-government-investment-projects-499ea3?utm_source=rss&utm_medium=feed")
    expect(feed?.item.pubDate).toBe(Date.UTC(2026, 10, 21, 12, 37, 13))
  })

  it("热榜下一轮名次变化被保留，快讯同一条不重复入 items", async () => {
    const { collector, store, db, advance } = await setup()
    await collector.tick()
    hnPage = swapFirstTwoStories(hnPage)
    advance(10 * MIN)
    await collector.tick()

    const top = await store.getItemHistory("hackernews", "50532613")
    expect(top?.observations.map(o => o.rank)).toEqual([1, 2])
    // 快讯 interval 更短，所以也抓了第二次；同一条新闻只有一行 items，两行 observations
    expect((await db.prepare("SELECT COUNT(*) AS n FROM items WHERE source_id = 'jin10'").get() as any).n).toBe(5)
    expect((await db.prepare("SELECT COUNT(*) AS n FROM observations WHERE source_id = 'jin10'").all() as any)[0].n).toBe(10)
    // 30 分钟一档的 RSS 还没到期，没有被抓第二次
    expect((await db.prepare("SELECT COUNT(DISTINCT observed_at) AS n FROM observations WHERE source_id = 'kaopu'").get() as any).n).toBe(1)
  })

  it("其中一个站点挂了（抓取抛错），另外两个照常入库，失败可查", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url)
      if (u.startsWith("https://www.jin10.com/")) throw new Error("[GET] jin10: 503 Service Unavailable")
      if (u.startsWith("https://news.ycombinator.com")) return hnPage
      return fixture("kaopu-feed.xml")
    })
    const { collector, store } = await setup()
    const summary = await collector.tick()
    expect(summary.succeeded.sort()).toEqual(["hackernews", "kaopu"])
    expect(summary.failed).toEqual([{ sourceId: "jin10", error: "[GET] jin10: 503 Service Unavailable" }])
    const jin = (await store.getHealth()).find(h => h.sourceId === "jin10")
    expect(jin).toMatchObject({ consecutiveFailures: 1, lastSuccessAt: null })
  })
})
