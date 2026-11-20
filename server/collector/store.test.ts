import { createDatabase } from "db0"
import sqlite from "db0/connectors/node-sqlite"
import { ObservationStore, decodeCursor, parsePubDate } from "./store"

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const MIN = 60 * 1000

async function newStore() {
  const store = new ObservationStore(createDatabase(sqlite({ name: ":memory:" })))
  await store.init()
  return store
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `title ${id}`, url: `https://example.test/${id}`, ...extra })

describe("parsePubDate", () => {
  it("reads milliseconds, seconds, numeric strings and date strings", () => {
    expect(parsePubDate(T0 - MIN, T0)).toBe(T0 - MIN)
    expect(parsePubDate((T0 - MIN) / 1000, T0)).toBe(T0 - MIN)
    expect(parsePubDate(String(T0 - MIN), T0)).toBe(T0 - MIN)
    expect(parsePubDate("2026-11-20T11:59:00Z", T0)).toBe(T0 - MIN)
  })

  it("rejects missing, unparseable and far-future values", () => {
    expect(parsePubDate(undefined, T0)).toBeUndefined()
    expect(parsePubDate("", T0)).toBeUndefined()
    expect(parsePubDate("3 分钟前", T0)).toBeUndefined()
    expect(parsePubDate(T0 + 60 * MIN, T0)).toBeUndefined()
  })
})

describe("observationStore", () => {
  it("keeps the first-seen time when the same item is collected again", async () => {
    const store = await newStore()
    expect(await store.record("hot", [item("a")], T0)).toBe(1)
    expect(await store.record("hot", [item("a")], T0 + 10 * MIN)).toBe(0)

    const { items } = await store.feed()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ source: "hot", id: "a", firstSeen: T0, lastSeen: T0 + 10 * MIN, time: T0, rank: 1 })
    expect(items[0].pubDate).toBeUndefined()
  })

  it("does not overwrite earlier items when a later round returns different ones", async () => {
    const store = await newStore()
    await store.record("hot", [item("a"), item("b")], T0)
    await store.record("hot", [item("c")], T0 + 10 * MIN)

    const { items } = await store.feed()
    expect(items.map(i => i.id).sort()).toEqual(["a", "b", "c"])
  })

  it("orders the stream by publish time when the source gives one, else by first-seen time", async () => {
    const store = await newStore()
    await store.record("flash", [item("old", { pubDate: T0 - 30 * MIN }), item("new", { pubDate: T0 - MIN })], T0)
    await store.record("hot", [item("ranked")], T0 - 10 * MIN)

    const { items } = await store.feed()
    expect(items.map(i => i.id)).toEqual(["new", "ranked", "old"])
    expect(items.map(i => i.time)).toEqual([T0 - MIN, T0 - 10 * MIN, T0 - 30 * MIN])
  })

  it("records rank history only when the rank changes", async () => {
    const store = await newStore()
    await store.record("hot", [item("a"), item("b")], T0)
    await store.record("hot", [item("a"), item("b")], T0 + 10 * MIN)
    await store.record("hot", [item("b"), item("a")], T0 + 20 * MIN)

    expect(await store.rankHistory("hot", "a")).toEqual([
      { observedAt: T0, rank: 1 },
      { observedAt: T0 + 20 * MIN, rank: 2 },
    ])
  })

  it("pages through many items that share one timestamp without skipping or repeating", async () => {
    const store = await newStore()
    const ids = Array.from({ length: 25 }, (_, i) => `n${String(i).padStart(2, "0")}`)
    await store.record("hot", ids.map(id => item(id)), T0)

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await store.feed({ limit: 10, cursor })
      seen.push(...page.items.map(i => i.id))
      cursor = page.nextCursor
      pages++
    } while (cursor && pages < 10)

    expect(pages).toBe(3)
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  it("filters by source and by time, and clamps the limit", async () => {
    const store = await newStore()
    await store.record("a", [item("1")], T0)
    await store.record("b", [item("2")], T0 + MIN)
    await store.record("c", [item("3")], T0 + 2 * MIN)

    expect((await store.feed({ sources: ["a", "c"] })).items.map(i => i.id)).toEqual(["3", "1"])
    expect((await store.feed({ after: T0 })).items.map(i => i.id)).toEqual(["3", "2"])
    expect((await store.feed({ before: T0 + 2 * MIN })).items.map(i => i.id)).toEqual(["2", "1"])
    expect((await store.feed({ limit: 0 })).items).toHaveLength(1)
  })

  it("ignores a duplicated id inside one batch", async () => {
    const store = await newStore()
    expect(await store.record("hot", [item("a"), item("a"), item("b")], T0)).toBe(2)
    expect((await store.feed()).items.find(i => i.id === "a")?.rank).toBe(1)
  })

  it("rejects a cursor it cannot read", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow("Invalid cursor")
  })

  it("tracks consecutive failures and clears them on success", async () => {
    const store = await newStore()
    await store.recordFailure("hot", "timeout", T0)
    await store.recordFailure("hot", "timeout again", T0 + MIN)
    expect(await store.health()).toEqual([
      { source: "hot", lastFailure: T0 + MIN, consecutiveFailures: 2, lastError: "timeout again" },
    ])

    await store.recordSuccess("hot", 30, T0 + 2 * MIN)
    expect(await store.health()).toEqual([
      { source: "hot", lastSuccess: T0 + 2 * MIN, lastFailure: T0 + MIN, consecutiveFailures: 0, lastError: "timeout again", lastItemCount: 30 },
    ])
  })

  it("prunes old rank history but keeps the items", async () => {
    const store = await newStore()
    await store.record("hot", [item("a")], T0)
    await store.pruneObservations(T0 + MIN)
    expect(await store.rankHistory("hot", "a")).toEqual([])
    expect((await store.feed()).items).toHaveLength(1)
  })
})
