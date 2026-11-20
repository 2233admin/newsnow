import { createDatabase } from "db0"
import sqlite from "db0/connectors/node-sqlite"
import { Collector, MIN_INTERVAL, dueSources } from "./scheduler"
import type { CollectorSource } from "./scheduler"
import { ObservationStore } from "./store"

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const MIN = 60 * 1000

async function newStore() {
  const store = new ObservationStore(createDatabase(sqlite({ name: ":memory:" })))
  await store.init()
  return store
}

function source(id: string, interval: number, fetch?: CollectorSource["fetch"]): CollectorSource & { calls: number } {
  const s = {
    id,
    interval,
    calls: 0,
    fetch: async () => {
      s.calls++
      return fetch ? fetch() : [{ id: `${id}-${s.calls}`, title: id, url: `https://example.test/${id}` }]
    },
  }
  return s
}

describe("dueSources", () => {
  it("picks sources never run and those past their own interval", () => {
    const fast = source("fast", 2 * MIN)
    const slow = source("slow", 30 * MIN)
    const fresh = source("fresh", 2 * MIN)
    const lastRun = new Map([["fast", T0 - 2 * MIN], ["slow", T0 - 2 * MIN]])
    expect(dueSources([fast, slow, fresh], lastRun, T0).map(s => s.id)).toEqual(["fast", "fresh"])
  })

  it("never runs a source more often than the minimum interval", () => {
    const test = source("test", 1)
    expect(dueSources([test], new Map([["test", T0 - MIN_INTERVAL + 1]]), T0)).toEqual([])
    expect(dueSources([test], new Map([["test", T0 - MIN_INTERVAL]]), T0)).toEqual([test])
  })
})

describe("collector", () => {
  it("collects each source on its own interval without waiting for a request", async () => {
    const store = await newStore()
    const fast = source("fast", 2 * MIN)
    const slow = source("slow", 30 * MIN)
    let now = T0
    const collector = new Collector({ store, sources: [fast, slow], now: () => now })

    expect((await collector.runOnce()).attempted.sort()).toEqual(["fast", "slow"])
    now = T0 + MIN
    expect((await collector.runOnce()).attempted).toEqual([])
    now = T0 + 2 * MIN
    expect((await collector.runOnce()).attempted).toEqual(["fast"])

    expect(fast.calls).toBe(2)
    expect(slow.calls).toBe(1)
    expect((await store.feed()).items).toHaveLength(3)
  })

  it("keeps collecting the other sources when one fails, and records the failure", async () => {
    const store = await newStore()
    const errors: string[] = []
    const broken = source("broken", 2 * MIN, async () => {
      throw new Error("upstream 503")
    })
    const fine = source("fine", 2 * MIN)
    const collector = new Collector({ store, sources: [broken, fine], now: () => T0, onError: id => errors.push(id) })

    const round = await collector.runOnce()
    expect(round.failed).toEqual(["broken"])
    expect(round.succeeded).toEqual(["fine"])
    expect(round.added).toBe(1)
    expect(errors).toEqual(["broken"])
    expect(await store.health()).toEqual([
      { source: "broken", lastFailure: T0, consecutiveFailures: 1, lastError: "upstream 503" },
      { source: "fine", lastSuccess: T0, consecutiveFailures: 0, lastItemCount: 1 },
    ])
  })

  it("retries a failed source on its interval, not on every tick", async () => {
    const store = await newStore()
    const broken = source("broken", 10 * MIN, async () => {
      throw new Error("down")
    })
    let now = T0
    const collector = new Collector({ store, sources: [broken], now: () => now })
    await collector.runOnce()
    now = T0 + MIN
    await collector.runOnce()
    expect(broken.calls).toBe(1)
    now = T0 + 10 * MIN
    await collector.runOnce()
    expect(broken.calls).toBe(2)
  })

  it("skips a round while the previous one is still running", async () => {
    const store = await newStore()
    let release: () => void = () => {}
    const slow = source("slow", 2 * MIN, () => new Promise((resolve) => {
      release = () => resolve([])
    }))
    const collector = new Collector({ store, sources: [slow], now: () => T0 })

    const first = collector.runOnce()
    await Promise.resolve()
    expect((await collector.runOnce()).attempted).toEqual([])
    release()
    expect((await first).attempted).toEqual(["slow"])
  })
})
