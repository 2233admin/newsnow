import { describe, expect, it, vi } from "vitest"
import { T0, descriptors, feedWorld, ingest, keyOf, row } from "../feed/helpers"
import { normalizeFeedParams } from "#/feed/params"
import { openFeedStream } from "#/feed/stream"
import type { StreamEvent } from "#/feed/stream"

// 审阅 #8 第 1 项：先按来源 / 分类 / 停用筛，再在筛剩的集合里收拢；组的代表行 = 范围内 seq 最小的那条。
function DESCS() {
  return descriptors([
    { id: "cls-telegraph", name: "财联社电报", category: "finance", builtin: true, enabled: true },
    { id: "wallstreetcn-quick", name: "华尔街见闻快讯", category: "finance", builtin: true, enabled: true },
    { id: "ths", name: "同花顺快讯", category: "tech", builtin: true, enabled: true },
  ])
}
const FLASH = "以军袭击加沙城一辆汽车，致3死多伤，当地医院证实"

async function three() {
  const w = await feedWorld(DESCS(), { enrich: true })
  await ingest(w, "cls-telegraph", [row("c1", { title: FLASH, url: "https://cls.example/1" })], T0)
  await ingest(w, "wallstreetcn-quick", [row("w1", { title: FLASH, url: "https://w.example/1" })], T0 + 1000)
  await ingest(w, "ths", [row("t1", { title: FLASH, url: "https://t.example/1" })], T0 + 2000)
  return w
}

describe("先筛再收拢（默认每组一行）", () => {
  it("三个源各一条同一件事：按每个源筛都出一行，代表行是范围内最早的那条", async () => {
    const w = await three()
    for (const [source, expected] of [["cls-telegraph", "cls-telegraph/c1"], ["wallstreetcn-quick", "wallstreetcn-quick/w1"], ["ths", "ths/t1"]]) {
      const res = await w.service.query({ source })
      expect(res.items.map(keyOf), source).toEqual([expected])
      expect(res.items[0].groupId, source).toBe(1) // 组 id 始终是主条目的 seq
      expect(res.items[0].sourcesCount, source).toBe(3)
    }
    expect((await w.service.query({ source: "ths,wallstreetcn-quick" })).items.map(keyOf)).toEqual(["wallstreetcn-quick/w1"])
    expect((await w.service.query({})).items.map(keyOf)).toEqual(["cls-telegraph/c1"])
  })

  it("代表行是成员时，members 列出组里的其余条目（含主条目）", async () => {
    const w = await three()
    const [item] = (await w.service.query({ source: "ths" })).items
    expect(item.dupOf).toBe(1)
    expect(item.members.map(m => m.itemId).sort()).toEqual(["c1", "w1"])
  })

  it("按分类、停用也一样：主条目在范围外，组仍然出一行", async () => {
    const w = await three()
    expect((await w.service.query({ category: "tech" })).items.map(keyOf)).toEqual(["ths/t1"])
    w.state.descs = w.state.descs.map(d => d.id === "cls-telegraph" ? { ...d, enabled: false } : d)
    expect((await w.service.query({})).items.map(keyOf)).toEqual(["wallstreetcn-quick/w1"])
    expect((await w.service.query({ includeInactive: "1" })).items.map(keyOf)).toEqual(["cls-telegraph/c1"])
  })

  it("expand=1 不变：范围内每条都出现", async () => {
    const w = await three()
    expect((await w.service.query({ source: "ths,wallstreetcn-quick", expand: "1" })).items.map(keyOf)).toEqual(["ths/t1", "wallstreetcn-quick/w1"])
  })

  it("翻页期间范围内来了同组的新成员：代表行与游标不变，每行恰好一次", async () => {
    const w = await three()
    await ingest(w, "ths", [row("t3", { title: "完全无关的另一条新闻，用来翻第二页的内容", url: "https://t.example/3" })], T0 - 1000)
    const first = await w.service.query({ source: "ths,wallstreetcn-quick", limit: "1" })
    expect(first.items.map(keyOf)).toEqual(["wallstreetcn-quick/w1"])
    await ingest(w, "ths", [row("t2", { title: FLASH, url: "https://t.example/2" })], T0 + 3000)
    const second = await w.service.query({ source: "ths,wallstreetcn-quick", limit: "1", cursor: first.nextCursor })
    expect(second.items.map(keyOf)).toEqual(["ths/t3"])
  })
})

describe("sSE 按范围订阅", () => {
  async function open(w: Awaited<ReturnType<typeof feedWorld>>, query: Record<string, unknown>) {
    const events: StreamEvent[] = []
    const handle = openFeedStream({ store: w.store, feed: w.feedStore, describe: async () => w.state.descs }, normalizeFeedParams(query), undefined, e => events.push(e))
    await handle.ready
    return { events, handle }
  }
  const shape = (events: StreamEvent[]) => events.slice(1).map(e => e.type === "item" ? ["item", e.item.itemId, e.item.groupId] : e.type === "merge" ? ["merge", e.seq, e.groupId] : [e.type])

  it("订阅范围里组的第一条推 item（即使它在全局是成员），之后的成员才推 merge", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    const onlyThs = await open(w, { source: "ths" })
    const two = await open(w, { source: "ths,wallstreetcn-quick" })
    await ingest(w, "cls-telegraph", [row("c1", { title: FLASH, url: "https://cls.example/1" })], T0)
    await ingest(w, "wallstreetcn-quick", [row("w1", { title: FLASH, url: "https://w.example/1" })], T0 + 1000)
    await ingest(w, "ths", [row("t1", { title: FLASH, url: "https://t.example/1" })], T0 + 2000)
    await vi.waitFor(() => expect(two.events.length).toBe(3))
    expect(shape(onlyThs.events)).toEqual([["item", "t1", 1]])
    expect(shape(two.events)).toEqual([["item", "w1", 1], ["merge", 3, 1]])
    onlyThs.handle.close()
    two.handle.close()
  })
})

// 复审 #8 跟进：关键词（q）与时间范围（from / to / since）也是范围的一部分，代表行 = 范围内 seq 最小的那条。
describe("关键词与时间范围也先筛再收拢", () => {
  /** 同链接并成一组，标题各不相同：只有 ths 的成员标题含「。」 */
  async function byLink() {
    const w = await feedWorld(DESCS(), { enrich: true })
    await ingest(w, "cls-telegraph", [row("c1", { title: "财联社版本的标题，没有句号", url: "https://news.example.com/p/1" })], T0)
    await ingest(w, "wallstreetcn-quick", [row("w1", { title: "见闻版本的标题，同样没有句号", url: "https://news.example.com/p/1?utm_source=x" })], T0 + 1000)
    await ingest(w, "ths", [row("t1", { title: "同花顺版本的标题，带句号。", url: "https://www.news.example.com/p/1/" })], T0 + 2000)
    return w
  }

  it("q 命中的只是组里某个成员：该组出一行（代表行是范围内最早的命中条目）", async () => {
    const w = await byLink()
    expect((await w.service.query({})).items.map(keyOf)).toEqual(["cls-telegraph/c1"])
    expect((await w.service.query({ q: "。" })).items.map(keyOf)).toEqual(["ths/t1"])
    expect((await w.service.query({ q: "。", source: "ths" })).items.map(keyOf)).toEqual(["ths/t1"])
    expect((await w.service.query({ q: "版本" })).items.map(keyOf)).toEqual(["cls-telegraph/c1"]) // 都命中：主条目
    expect((await w.service.query({ q: "没有句号", source: "wallstreetcn-quick,ths" })).items.map(keyOf)).toEqual(["wallstreetcn-quick/w1"])
  })

  it("时间范围：主条目在范围外、成员在范围内，这一组仍出一行", async () => {
    const w = await byLink()
    expect((await w.service.query({ from: String(T0 + 1500) })).items.map(keyOf)).toEqual(["ths/t1"])
    expect((await w.service.query({ to: String(T0 + 500) })).items.map(keyOf)).toEqual(["cls-telegraph/c1"])
    expect((await w.service.query({ from: String(T0 + 500), to: String(T0 + 1500) })).items.map(keyOf)).toEqual(["wallstreetcn-quick/w1"])
  })

  it("同一筛选范围内代表行稳定、游标不重不漏：翻页中途范围内来了同组新成员", async () => {
    const w = await byLink()
    await ingest(w, "ths", [row("t0", { title: "另一条无关的新闻，用来翻第二页，带句号。", url: "https://t.example/x" })], T0 - 5000)
    for (const [params, head] of [[{ q: "。" }, "ths/t1"], [{ from: String(T0 - 10_000) }, "cls-telegraph/c1"], [{ q: "。", source: "ths", from: String(T0 - 10_000) }, "ths/t1"]] as const) {
      const first = await w.service.query({ ...params, limit: "1" })
      expect(first.items.map(keyOf), JSON.stringify(params)).toEqual([head])
      await ingest(w, "ths", [row(`late${JSON.stringify(params).length}`, { title: "同花顺版本的标题，带句号。", url: "https://www.news.example.com/p/1/" })], T0 + 9000)
      const second = await w.service.query({ ...params, limit: "1", cursor: first.nextCursor })
      expect(second.items.map(keyOf), JSON.stringify(params)).toEqual(["ths/t0"])
      expect(second.nextCursor).toBeNull()
    }
  })

  it("sSE 带关键词订阅：范围里组的第一条推 item，之后的命中成员才推 merge", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    const events: StreamEvent[] = []
    const handle = openFeedStream({ store: w.store, feed: w.feedStore, describe: async () => w.state.descs }, normalizeFeedParams({ q: "。" }), undefined, e => events.push(e))
    await handle.ready
    await ingest(w, "cls-telegraph", [row("c1", { title: "财联社版本的标题，没有句号", url: "https://news.example.com/p/1" })], T0)
    await ingest(w, "ths", [row("t1", { title: "同花顺版本的标题，带句号。", url: "https://news.example.com/p/1" })], T0 + 1000)
    await ingest(w, "wallstreetcn-quick", [row("w1", { title: "见闻版本的标题，也带句号。", url: "https://news.example.com/p/1" })], T0 + 2000)
    await vi.waitFor(() => expect(events.length).toBe(3))
    expect(events.slice(1).map(e => e.type === "item" ? ["item", e.item.itemId] : e.type === "merge" ? ["merge", e.seq, e.groupId] : [e.type])).toEqual([["item", "t1"], ["merge", 3, 1]])
    handle.close()
  })
})

// #9 审阅：since 是位置条件（与游标一样），不进范围；标的按组判断。
describe("since 是位置条件，不进范围", () => {
  it("拉新：老组的新成员不会被当成新的一行；since 之后才有的新组照常返回", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    await ingest(w, "cls-telegraph", [row("c1", { title: FLASH, url: "https://cls.example/1" })], T0)
    await ingest(w, "ths", [row("t1", { title: FLASH, url: "https://t.example/1" })], T0 + 5000)
    await ingest(w, "ths", [row("n1", { title: "一条全新的、与上面无关的新闻，用来确认新组照常返回", url: "https://t.example/n" })], T0 + 6000)
    expect((await w.service.query({ since: String(T0 + 5000) })).items.map(keyOf)).toEqual(["ths/n1"])
    // 订阅 ths 的客户端：范围里这个组的第一条就是 t1，它本来就是新行
    expect((await w.service.query({ since: String(T0 + 5000), source: "ths" })).items.map(keyOf)).toEqual(["ths/n1", "ths/t1"])
  })
})

describe("标的按组判断（默认每组一行）", () => {
  async function nvda() {
    const w = await feedWorld(DESCS(), { enrich: true })
    await ingest(w, "cls-telegraph", [row("c1", { title: "英伟达宣布：以军袭击加沙城一辆汽车，致3死多伤", url: "https://news.example.com/g/1" })], T0)
    await ingest(w, "ths", [row("t1", { title: "以军袭击加沙城一辆汽车，致3死多伤，医院证实了", url: "https://news.example.com/g/1?utm_source=t" })], T0 + 1000)
    return w
  }

  it("标的只挂在范围外的主条目上：按来源筛时代表行是成员，整组仍然出一行", async () => {
    const w = await nvda()
    expect((await w.service.query({ symbol: "NVDA.XNAS" })).items.map(keyOf)).toEqual(["cls-telegraph/c1"])
    expect((await w.service.query({ symbol: "NVDA.XNAS", source: "ths" })).items.map(keyOf)).toEqual(["ths/t1"])
    expect((await w.service.query({ symbol: "NVDA.XNAS", q: "医院证实" })).items.map(keyOf)).toEqual(["ths/t1"])
    expect((await w.service.query({ symbol: "TSLA.XNAS", source: "ths" })).items).toEqual([])
  })

  it("expand=1 仍按条判断", async () => {
    const w = await nvda()
    expect((await w.service.query({ symbol: "NVDA.XNAS", expand: "1" })).items.map(keyOf)).toEqual(["cls-telegraph/c1"])
  })

  it("sSE 带标的订阅：组里任一成员带标的就算命中，范围里组的第一条推 item", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    const events: StreamEvent[] = []
    const handle = openFeedStream({ store: w.store, feed: w.feedStore, describe: async () => w.state.descs }, normalizeFeedParams({ symbol: "NVDA.XNAS", source: "ths" }), undefined, e => events.push(e))
    await handle.ready
    await ingest(w, "cls-telegraph", [row("c1", { title: "英伟达宣布：以军袭击加沙城一辆汽车，致3死多伤", url: "https://news.example.com/g/1" })], T0)
    await ingest(w, "ths", [row("t1", { title: "以军袭击加沙城一辆汽车，致3死多伤，医院证实了", url: "https://news.example.com/g/1?utm_source=t" })], T0 + 1000)
    await vi.waitFor(() => expect(events.length).toBe(2))
    expect(events.slice(1).map(e => e.type === "item" ? ["item", e.item.itemId] : [e.type])).toEqual([["item", "t1"]])
    handle.close()
  })
})
