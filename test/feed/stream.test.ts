import { describe, expect, it, vi } from "vitest"
import { T0, descriptors, feedWorld, ingest, row } from "./helpers"
import { normalizeFeedParams } from "#/feed/params"
import { REPLAY_MAX, openFeedStream } from "#/feed/stream"
import type { StreamEvent } from "#/feed/stream"

async function connect(w: Awaited<ReturnType<typeof feedWorld>>, query: Record<string, unknown> = {}, lastEventId?: number) {
  const events: StreamEvent[] = []
  const handle = openFeedStream({ store: w.store, feed: w.feedStore, describe: async () => w.state.descs }, normalizeFeedParams(query), lastEventId, e => events.push(e))
  await handle.ready
  const items = () => events.flatMap(e => e.type === "item" ? [e.item] : [])
  return { events, handle, items, ids: () => items().map(i => i.seq) }
}
const batch = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`))

describe("实时推送（SSE 的核心）", () => {
  it("不带 Last-Event-ID：先收到 ready，只推连上之后入库的新条目", async () => {
    const w = await feedWorld()
    await ingest(w, "jin10", batch("old", 3), T0)
    const c = await connect(w)
    expect(c.events).toEqual([{ type: "ready", latestSeq: 3 }])
    await ingest(w, "jin10", [...batch("old", 3), ...batch("new", 2)], T0 + 60_000)
    await vi.waitFor(() => expect(c.ids()).toEqual([4, 5]))
    expect(c.items()[0]).toMatchObject({ sourceId: "jin10", sourceName: "金十数据", category: "finance", itemId: "new0", seq: 4 })
    expect(c.items().map(i => i.itemId)).toEqual(["new0", "new1"])
  })

  it("带 Last-Event-ID：补发之后的，再接实时，序号连续、不重复", async () => {
    const w = await feedWorld()
    await ingest(w, "jin10", batch("a", 5), T0)
    const c = await connect(w, {}, 2)
    expect(c.ids()).toEqual([3, 4, 5])
    await ingest(w, "weibo", batch("b", 2), T0 + 1)
    await vi.waitFor(() => expect(c.ids()).toEqual([3, 4, 5, 6, 7]))
  })

  it("补发过程中（连接建立到补发完成之间）入库的条目既不丢也不重", async () => {
    const w = await feedWorld()
    await ingest(w, "jin10", batch("a", 30), T0)
    const events: StreamEvent[] = []
    const handle = openFeedStream({ store: w.store, feed: w.feedStore, describe: async () => w.state.descs }, normalizeFeedParams({}), 0, e => events.push(e))
    // 不等 ready：补发还在读库时就连着入库几批
    await Promise.all([1, 2, 3, 4].map(k => ingest(w, ["weibo", "hackernews", "user:a", "user:b"][k - 1], batch(`m${k}-`, 20), T0 + k)))
    await handle.ready
    await vi.waitFor(() => expect(events.filter(e => e.type === "item")).toHaveLength(110))
    const seqs = events.flatMap(e => e.type === "item" ? [e.item.seq] : [])
    expect(seqs).toEqual(Array.from({ length: 110 }, (_, i) => i + 1))
  })

  it("断线重连：用最后收到的 id 续上，整个过程一条不少、不重复", async () => {
    const w = await feedWorld()
    const c1 = await connect(w)
    await ingest(w, "jin10", batch("a", 10), T0)
    await vi.waitFor(() => expect(c1.ids()).toHaveLength(10))
    c1.handle.close() // 断线
    // 断线期间入库
    await ingest(w, "hackernews", batch("b", 7), T0 + 1)
    await ingest(w, "jin10", batch("c", 4), T0 + 2)
    const last = c1.ids().at(-1)!
    const c2 = await connect(w, {}, last)
    await ingest(w, "weibo", batch("d", 3), T0 + 3)
    await vi.waitFor(() => expect(c2.ids()).toHaveLength(14))
    expect([...c1.ids(), ...c2.ids()]).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
  })

  it("关闭后取消订阅，不再推", async () => {
    const w = await feedWorld()
    const c = await connect(w)
    c.handle.close()
    await ingest(w, "jin10", batch("a", 2), T0)
    await new Promise(r => setTimeout(r, 20))
    expect(c.ids()).toEqual([])
  })

  it("落后超过补发上限发 reset 并从最新处续；Last-Event-ID 比库里最大的还大（库被换过）也发 reset", async () => {
    const w = await feedWorld()
    for (let i = 0; i < Math.ceil((REPLAY_MAX + 20) / 150); i++) await ingest(w, "jin10", batch(`x${i}-`, 150), T0 + i)
    const head = await w.feedStore.latestSeq()
    expect(head).toBeGreaterThan(REPLAY_MAX + 1)
    const far = await connect(w, {}, 0)
    expect(far.events).toEqual([{ type: "ready", latestSeq: head }, { type: "reset", latestSeq: head }])
    expect(far.ids()).toEqual([])
    const ahead = await connect(w, {}, head + 500)
    expect(ahead.events.map(e => e.type)).toEqual(["ready", "reset"])
    // 刚好在上限内：补发
    const edge = await connect(w, {}, head - REPLAY_MAX)
    expect(edge.ids()).toHaveLength(REPLAY_MAX)
    // reset 之后接着推实时
    await ingest(w, "weibo", batch("z", 1), T0 + 9999)
    await vi.waitFor(() => expect(far.ids()).toEqual([head + 1]))
  })

  it("筛选：来源、分类、关键词对补发和实时都生效；没匹配的也推进水位", async () => {
    const w = await feedWorld()
    await ingest(w, "jin10", [row("g1", { title: "黄金 涨" }), row("g2", { title: "原油 跌" })], T0)
    await ingest(w, "hackernews", [row("h1", { title: "黄金 HN" })], T0 + 1)
    const bySource = await connect(w, { source: "jin10" }, 0)
    expect(bySource.items().map(i => i.itemId)).toEqual(["g1", "g2"])
    const byCategory = await connect(w, { category: "tech" }, 0)
    expect(byCategory.items().map(i => i.itemId)).toEqual(["h1"])
    const byQ = await connect(w, { q: "黄金" }, 0)
    expect(byQ.items().map(i => i.itemId)).toEqual(["g1", "h1"])
    await ingest(w, "weibo", [row("w1", { title: "无关" })], T0 + 2)
    await ingest(w, "jin10", [row("g3", { title: "黄金 再涨" })], T0 + 3)
    await vi.waitFor(() => expect(byQ.items().map(i => i.itemId)).toEqual(["g1", "h1", "g3"]))
    expect(byQ.handle.watermark()).toBe(5) // 无关的 w1（seq 4）也算处理过
    expect(bySource.items().map(i => i.itemId)).toEqual(["g1", "g2", "g3"])
  })

  it("推送的条目里链接也只给 http / https", async () => {
    const w = await feedWorld()
    const c = await connect(w)
    await ingest(w, "jin10", [row("bad", { url: "javascript:alert(1)" }), row("good", { url: "https://ok.example/x" })], T0)
    await vi.waitFor(() => expect(c.ids()).toHaveLength(2))
    expect(c.items().map(i => i.url)).toEqual([null, "https://ok.example/x"])
  })

  it("标的筛选：只推带这个标的的条目", async () => {
    const w = await feedWorld(descriptors(), { enrich: true })
    const c = await connect(w, { symbol: "600519.XSHG" })
    expect(c.events[0]).toEqual({ type: "ready", latestSeq: 0 })
    await ingest(w, "jin10", [row("a", { title: "贵州茅台公告回购股份，涨停" }), row("b", { title: "黄金突破2500美元" }), row("c", { title: "英伟达财报超预期" })], T0)
    await vi.waitFor(() => expect(c.ids()).toHaveLength(1))
    expect(c.items().map(i => [i.itemId, i.symbols])).toEqual([["a", ["600519.XSHG"]]])
  })
})
