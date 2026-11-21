import { describe, expect, it, vi } from "vitest"
import type { NewsItem } from "@shared/types"
import { memoryStore, selectAll } from "./helpers"
import { COLLECTOR_DEFAULTS } from "#/collector/config"
import type { CollectorConfig } from "#/collector/config"
import { DUE_TOLERANCE_MS, collectableSourceIds, createCollector, isDue } from "#/collector/collect"
import type { SourceGetters, SourceMetas } from "#/collector/collect"

const MIN = 60_000
const quiet = { info: () => {}, warn: () => {} }
const config = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({ enabled: true, ...COLLECTOR_DEFAULTS, ...over })
const list = (prefix: string, n = 3): NewsItem[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, title: `${prefix} 标题 ${i}`, url: `u/${prefix}/${i}` }))

async function setup(sources: SourceMetas, getters: SourceGetters, over: Partial<CollectorConfig> = {}) {
  const { store, db } = await memoryStore()
  let now = 1_000_000
  const collector = createCollector({ store, getters, sources, config: config(over), clock: () => now, log: quiet })
  return { store, db, collector, advance: (ms: number) => {
    now += ms
  }, now: () => now }
}

describe("isDue", () => {
  it("没抓过的立即到期；没到 interval 不到期；容忍 tick 偏早一点", () => {
    expect(isDue(null, 10 * MIN, 5)).toBe(true)
    expect(isDue(0, 10 * MIN, 5 * MIN)).toBe(false)
    expect(isDue(0, 2 * MIN, 2 * MIN - DUE_TOLERANCE_MS)).toBe(true)
    expect(isDue(0, 2 * MIN, 2 * MIN - DUE_TOLERANCE_MS - 1)).toBe(false)
  })
})

describe("collectableSourceIds", () => {
  it("排除 redirect 与没有适配器的源，并按 only 过滤", () => {
    const sources: SourceMetas = {
      a: { interval: MIN },
      b: { interval: MIN, redirect: "a" as any },
      c: { interval: MIN },
      d: { interval: MIN },
    }
    const getters: SourceGetters = { a: async () => [], b: async () => [], d: async () => [] }
    expect(collectableSourceIds(sources, getters)).toEqual(["a", "d"])
    expect(collectableSourceIds(sources, getters, ["d"])).toEqual(["d"])
  })
})

describe("调度：按各源的 interval 分级，不依赖有人请求", () => {
  it("快讯源每个 interval 抓一次，慢的源没到期就不抓", async () => {
    const fast = vi.fn(async () => list("f"))
    const slow = vi.fn(async () => list("s"))
    const { collector, advance } = await setup(
      { fast: { interval: 2 * MIN }, slow: { interval: 10 * MIN } },
      { fast, slow },
    )

    await collector.tick() // t=0：都没抓过，都抓
    expect([fast.mock.calls.length, slow.mock.calls.length]).toEqual([1, 1])

    advance(1 * MIN)
    await collector.tick() // t=1 分钟：谁都没到期
    expect([fast.mock.calls.length, slow.mock.calls.length]).toEqual([1, 1])

    advance(1 * MIN)
    await collector.tick() // t=2 分钟：只有 fast 到期
    expect([fast.mock.calls.length, slow.mock.calls.length]).toEqual([2, 1])

    for (let i = 0; i < 8; i++) {
      advance(1 * MIN)
      await collector.tick()
    }
    // t=10 分钟：fast 共 6 次（0,2,4,6,8,10），slow 共 2 次（0,10）
    expect([fast.mock.calls.length, slow.mock.calls.length]).toEqual([6, 2])
  })

  it("进程重启后接着库里的 last_attempt_at 调度，不会立刻全量重抓", async () => {
    const getter = vi.fn(async () => list("a"))
    const { store, collector, advance } = await setup({ a: { interval: 10 * MIN } }, { a: getter })
    await collector.tick()
    advance(1 * MIN)
    // 新进程：同一个库，新的 collector
    let now = 1_000_000 + MIN
    const restarted = createCollector({ store, getters: { a: getter }, sources: { a: { interval: 10 * MIN } }, config: config(), clock: () => now, log: quiet })
    await restarted.tick()
    expect(getter).toHaveBeenCalledTimes(1)
    now += 9 * MIN
    await restarted.tick()
    expect(getter).toHaveBeenCalledTimes(2)
  })

  it("redirect 别名不重复抓", async () => {
    const getter = vi.fn(async () => list("a"))
    const { collector } = await setup(
      { "x": { interval: MIN, redirect: "x-main" as any }, "x-main": { interval: MIN } },
      { "x": getter, "x-main": getter },
    )
    const summary = await collector.tick()
    expect(summary.due).toEqual(["x-main"])
    expect(getter).toHaveBeenCalledTimes(1)
  })
})

describe("落库", () => {
  it("每次采集都落库，热榜条目的入流时间是第一次出现，名次变化被保留", async () => {
    let round = 0
    const hot = vi.fn(async (): Promise<NewsItem[]> => round++ === 0
      ? [{ id: "x", title: "X", url: "u/x" }, { id: "y", title: "Y", url: "u/y" }]
      : [{ id: "y", title: "Y", url: "u/y" }, { id: "x", title: "X", url: "u/x" }, { id: "z", title: "Z", url: "u/z" }])
    const { collector, store, advance, db } = await setup({ hot: { interval: 10 * MIN } }, { hot })
    await collector.tick()
    advance(10 * MIN)
    await collector.tick()

    const x = await store.getItemHistory("hot", "x")
    expect(x?.item.firstSeenAt).toBe(1_000_000)
    expect(x?.item.lastSeenAt).toBe(1_000_000 + 10 * MIN)
    expect(x?.observations.map(o => o.rank)).toEqual([1, 2])
    expect((await store.getItemHistory("hot", "z"))?.item.firstSeenAt).toBe(1_000_000 + 10 * MIN)
    expect(await selectAll(db, "SELECT * FROM observations")).toHaveLength(5)
  })

  it("超过 maxItemsPerSource 的部分不入库", async () => {
    const { collector, db } = await setup({ a: { interval: MIN } }, { a: async () => list("a", 50) }, { maxItemsPerSource: 20 })
    await collector.tick()
    expect(await selectAll(db, "SELECT * FROM items")).toHaveLength(20)
  })
})

describe("失败隔离与健康", () => {
  it("一个源抛错不影响其他源，失败状态可查，连续失败累加，成功后清零", async () => {
    let broken = true
    const getters: SourceGetters = {
      ok: async () => list("ok"),
      bad: async () => {
        if (broken) throw new Error("HTTP 503")
        return list("bad")
      },
    }
    const { collector, store, advance, db } = await setup({ ok: { interval: MIN }, bad: { interval: MIN } }, getters)

    const first = await collector.tick()
    expect(first.succeeded).toEqual(["ok"])
    expect(first.failed).toEqual([{ sourceId: "bad", error: "HTTP 503" }])
    expect(await selectAll(db, "SELECT DISTINCT source_id FROM items")).toEqual([{ source_id: "ok" }])

    advance(MIN)
    await collector.tick()
    const health = Object.fromEntries((await store.getHealth()).map(h => [h.sourceId, h]))
    expect(health.bad).toMatchObject({ consecutiveFailures: 2, lastError: "HTTP 503", lastSuccessAt: null })
    expect(health.ok).toMatchObject({ consecutiveFailures: 0, lastItemCount: 3 })

    broken = false
    advance(MIN)
    await collector.tick()
    expect((await store.getHealth()).find(h => h.sourceId === "bad")).toMatchObject({ consecutiveFailures: 0, lastItemCount: 3 })
  })

  it("适配器同步抛错、返回空列表、超时，都按失败记，且不拖住其他源", async () => {
    vi.useFakeTimers()
    try {
      const getters: SourceGetters = {
        sync: () => {
          throw new Error("同步抛错")
        },
        empty: async () => [],
        hang: () => new Promise<NewsItem[]>(() => {}),
        ok: async () => list("ok"),
      }
      const { collector, store } = await setup(
        { sync: { interval: MIN }, empty: { interval: MIN }, hang: { interval: MIN }, ok: { interval: MIN } },
        getters,
        { sourceTimeoutMs: 5_000 },
      )
      const pending = collector.tick()
      await vi.advanceTimersByTimeAsync(5_000)
      const summary = await pending
      expect(summary.succeeded).toEqual(["ok"])
      expect(Object.fromEntries(summary.failed.map(f => [f.sourceId, f.error]))).toEqual({
        sync: "同步抛错",
        empty: "empty result",
        hang: "timeout after 5000ms",
      })
      expect((await store.getHealth()).filter(h => h.consecutiveFailures === 1).map(h => h.sourceId).sort()).toEqual(["empty", "hang", "sync"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("记录失败时库本身出错，也不影响其他源继续被抓", async () => {
    const { collector, store } = await setup(
      { bad: { interval: MIN }, ok: { interval: MIN } },
      { bad: async () => {
        throw new Error("x")
      }, ok: async () => list("ok") },
    )
    vi.spyOn(store, "recordFailure").mockRejectedValue(new Error("db down"))
    const summary = await collector.tick()
    expect(summary.succeeded).toEqual(["ok"])
  })
})

describe("并发上限", () => {
  it("同时在抓的源不超过 concurrency", async () => {
    let active = 0
    let peak = 0
    const slowGetter = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 10))
      active--
      return list("a")
    }
    const sources: SourceMetas = {}
    const getters: SourceGetters = {}
    for (let i = 0; i < 12; i++) {
      sources[`s${i}`] = { interval: MIN }
      getters[`s${i}`] = slowGetter
    }
    const { collector } = await setup(sources, getters, { concurrency: 3 })
    const summary = await collector.tick()
    expect(summary.succeeded).toHaveLength(12)
    expect(peak).toBe(3)
  })

  it("上一轮没结束时再 tick，复用同一轮，不叠跑", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const getter = vi.fn(async () => {
      await gate
      return list("a")
    })
    const { collector } = await setup({ a: { interval: MIN } }, { a: getter })
    const t1 = collector.tick()
    const t2 = collector.tick()
    expect(t2).toBe(t1)
    release()
    await t1
    expect(getter).toHaveBeenCalledTimes(1)
  })
})
