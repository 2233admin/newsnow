/**
 * 同花顺快讯、淘股吧热帖两个适配器：用 2026-11-21 录下的真实响应（test/fixtures/）跑真的解析代码，不连网。
 * 只替换 myFetch（适配器唯一的出网口）。
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectDir } from "@shared/dir"
import sources from "@shared/sources.json"
import { memoryStore } from "../collector/helpers"
import { COLLECTOR_DEFAULTS } from "#/collector/config"
import { createCollector } from "#/collector/collect"

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock("#/utils/fetch", () => ({ myFetch: fetchMock }))

const { default: ths } = await import("#/sources/ths")
const { default: taoguba, parseTaogubaDate } = await import("#/sources/taoguba")

const fixture = (name: string) => readFileSync(join(projectDir, "test/fixtures", name), "utf8")
function CST(month: number, day: number, hour: number, minute: number, year = 2026) {
  return Date.UTC(year, month - 1, day, hour - 8, minute)
}

beforeEach(() => {
  // 固定「现在」为 2026-11-21 22:40 北京时间，淘股吧的发帖时间没有年份，要靠它补
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(CST(11, 21, 22, 40))
  fetchMock.mockReset()
})
afterEach(() => vi.useRealTimers())

describe("同花顺快讯", () => {
  const respond = (body: string) => fetchMock.mockImplementation(async () => JSON.parse(body))

  it("每条快讯有 id、标题、链接、发布时间（Unix 秒转毫秒）；重要的标 ✰，正文进 hover", async () => {
    respond(fixture("ths-flash.json"))
    const items = await ths()

    expect(items).toHaveLength(6)
    expect(items[0]).toMatchObject({
      id: "5729275",
      title: "亚投行将在香港设立办公室",
      url: "https://news.10jqka.com.cn/20261121/c682074479.shtml",
      pubDate: 1795271045 * 1000,
    })
    expect(items[0].extra?.hover).toContain("亚洲基础设施投资银行")
    expect(items[0].extra?.info).toBe(false)
    // 最后一条是同花顺标成重要的（import = "3"）
    expect(items[5]).toMatchObject({ id: "5728767", extra: { info: "✰" } })
    // 发布时间落在 2026-11-21（北京时间 22:24:05）
    expect(items[0].pubDate).toBe(CST(11, 21, 22, 24) + 5000)
  })

  it("请求的是快讯接口，并带 Referer", async () => {
    respond(fixture("ths-flash.json"))
    await ths()
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe("https://news.10jqka.com.cn/tapp/news/push/stock/")
    expect(options.query).toMatchObject({ page: 1, track: "website" })
    expect(options.headers.Referer).toContain("news.10jqka.com.cn")
  })

  it("接口返回 code 不是 200，或没有 list：抛错（让采集器记失败），不当成没有新闻", async () => {
    fetchMock.mockResolvedValue({ code: "500", msg: "系统繁忙", data: { list: [{ id: "1", title: "t", url: "https://x/1", ctime: "1" }] } })
    await expect(ths()).rejects.toThrow("同花顺快讯接口返回异常")
    fetchMock.mockResolvedValue({ code: "200", data: {} })
    await expect(ths()).rejects.toThrow("同花顺快讯接口返回异常")
  })

  it("缺 id、标题或链接的条目丢掉", async () => {
    fetchMock.mockResolvedValue({ code: "200", data: { list: [
      { id: "1", title: "好的", url: "https://x/1", ctime: "1795271045" },
      { id: "2", title: "", url: "https://x/2", ctime: "1795271045" },
      { id: "3", title: "没链接", url: "", ctime: "1795271045" },
    ] } })
    expect((await ths()).map(i => i.id)).toEqual(["1"])
  })
})

describe("淘股吧综合吧热帖", () => {
  it("按页面顺序解析：帖子号、完整标题、链接、发帖时间（补年份）、评论/浏览", async () => {
    fetchMock.mockResolvedValue(fixture("taoguba-bbs.html"))
    const items = await taoguba()

    expect(items.map(i => i.id)).toEqual(["2wRcFV2fxo7", "2wSyK5InxUB", "2wUw0pVPEeI", "2wSEPKH44jw", "2wQOdamlaSB", "2wUi0Wa85le"])
    expect(items[0]).toMatchObject({
      title: "11月20日早盘操作计划",
      url: "https://www.tgb.cn/a/2wRcFV2fxo7",
      pubDate: CST(11, 19, 21, 5),
      extra: { info: "评论/浏览 1269/30807", hover: "作者：风一样的胖刺猬" },
    })
    // 标题取 title 属性，不带「[精]」标记与前后空白
    expect(items[4].title).toBe("[红包]小七哥11.19复盘：如何利用盘眼思维确认周期起点？本篇送给当前迷茫的人。")
    expect(items[5]).toMatchObject({ pubDate: CST(11, 21, 17, 42), extra: { info: "评论/浏览 8/234" } })
  })

  it("页面没有帖子（结构变了）：抛错，不当成没有热帖", async () => {
    fetchMock.mockResolvedValue("<html><body><div class='Nbbs-middle-list'></div></body></html>")
    await expect(taoguba()).rejects.toThrow("没有解析出任何帖子")
  })

  it("发帖时间：没写年份的取今年，补完晚于现在 10 分钟以上的取去年；写了年份的照写；认不出的是 undefined", () => {
    const now = CST(1, 2, 8, 0)
    expect(parseTaogubaDate("12-30 10:00", now)).toBe(CST(12, 30, 10, 0, 2025))
    expect(parseTaogubaDate("01-02 07:59", now)).toBe(CST(1, 2, 7, 59))
    expect(parseTaogubaDate("2024-05-06 09:30", now)).toBe(CST(5, 6, 9, 30, 2024))
    // 时间容差只有 10 分钟：发帖日是「去年的明天」时必须补成去年，不能落在未来的明天
    const evening = CST(11, 21, 22, 40)
    expect(parseTaogubaDate("11-22 10:00", evening)).toBe(CST(11, 22, 10, 0, 2025))
    expect(parseTaogubaDate("11-22 22:40", evening)).toBe(CST(11, 22, 22, 40, 2025))
    // 10 分钟以内的「未来」算两边时钟误差，仍取今年；超过就取去年
    expect(parseTaogubaDate("11-21 22:50", evening)).toBe(CST(11, 21, 22, 50))
    expect(parseTaogubaDate("11-21 22:51", evening)).toBe(CST(11, 21, 22, 51, 2025))
    // 跨年边界：北京时间 1 月 1 日凌晨，刚过去的 12 月 31 日是去年；站点时间比本机快几分钟的 1 月 1 日帖子仍是今年
    const newYear = CST(1, 1, 0, 5)
    expect(parseTaogubaDate("12-31 23:50", newYear)).toBe(CST(12, 31, 23, 50, 2025))
    expect(parseTaogubaDate("01-01 00:10", newYear)).toBe(CST(1, 1, 0, 10))
    expect(parseTaogubaDate("01-01 00:20", newYear)).toBe(CST(1, 1, 0, 20, 2025))
    // 北京时间的年份与 UTC 不同的那几个小时：UTC 还是 12 月 31 日 16:30，北京已是 1 月 1 日 00:30
    expect(parseTaogubaDate("01-01 00:25", CST(1, 1, 0, 30))).toBe(CST(1, 1, 0, 25))
    expect(parseTaogubaDate("昨天", now)).toBeUndefined()
    expect(parseTaogubaDate("", now)).toBeUndefined()
  })
})

describe("两个新源进采集器与观测库", () => {
  it("元数据：同花顺是 2 分钟一档的快讯，淘股吧是 10 分钟一档的热榜，都在财经栏", () => {
    expect(sources.ths).toMatchObject({ column: "finance", type: "realtime", interval: 2 * 60_000 })
    expect(sources.taoguba).toMatchObject({ column: "finance", type: "hottest", interval: 10 * 60_000 })
  })

  it("一轮采集后两个源都有条目与观测，热帖名次按页面顺序；下一轮名次变化被保留", async () => {
    let bbs = fixture("taoguba-bbs.html")
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("10jqka")) return JSON.parse(fixture("ths-flash.json"))
      return bbs
    })
    const { store } = await memoryStore()
    let now = CST(11, 21, 22, 40)
    const collector = createCollector({
      store,
      getters: { ths, taoguba } as any,
      sources: { ths: { interval: sources.ths.interval }, taoguba: { interval: sources.taoguba.interval } } as any,
      config: { enabled: true, ...COLLECTOR_DEFAULTS },
      clock: () => now,
      log: { info: () => {}, warn: () => {} },
    })

    const summary = await collector.tick()
    expect(summary.failed).toEqual([])
    expect(summary.succeeded.sort()).toEqual(["taoguba", "ths"])
    expect((await store.getHealth()).map(h => [h.sourceId, h.lastItemCount]).sort()).toEqual([["taoguba", 6], ["ths", 6]])
    const flash = await store.getItemHistory("ths", "5729275")
    expect(flash?.item.pubDate).toBe(1795271045 * 1000)
    const post = await store.getItemHistory("taoguba", "2wRcFV2fxo7")
    expect(post?.observations.map(o => o.rank)).toEqual([1])

    // 十分钟后：第一、二个帖子对调
    const [head, ...rows] = bbs.split("<div class=\"Nbbs-tiezi-lists\">")
    ;[rows[0], rows[1]] = [rows[1], rows[0]]
    bbs = [head, ...rows].join("<div class=\"Nbbs-tiezi-lists\">")
    now += 10 * 60_000
    await collector.tick()
    expect((await store.getItemHistory("taoguba", "2wRcFV2fxo7"))?.observations.map(o => o.rank)).toEqual([1, 2])
  })
})
