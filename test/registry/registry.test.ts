import { describe, expect, it, vi } from "vitest"
import { FEED_ITEMS, RSS, setupWorld } from "./helpers"
import { COLLECTOR_DEFAULTS } from "#/collector/config"
import { createCollector } from "#/collector/collect"
import { createRegistry } from "#/registry/registry"

const MIN = 60_000
const quiet = { info: () => {}, warn: () => {} }
const builtinItems = [{ id: "b1", title: "内置一", url: "https://b/1" }]
const FEED = "https://feed.example/rss"

async function setup(pages: Record<string, string> = { [FEED]: RSS(FEED_ITEMS) }) {
  const world = await setupWorld(pages)
  const builtin = vi.fn(async () => builtinItems)
  const registry = createRegistry({
    builtinSources: { hn: { interval: 10 * MIN } },
    builtinGetters: { hn: builtin },
    store: world.store,
    fetchText: world.fetchText,
    log: quiet,
  })
  let now = 1_000_000
  const collector = createCollector({ store: world.observations, resolve: () => registry.snapshot(), config: { enabled: true, ...COLLECTOR_DEFAULTS }, clock: () => now, log: quiet })
  return { ...world, registry, collector, builtin, advance: (ms: number) => {
    now += ms
  } }
}

function add(w: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) {
  return w.service.create({ slug: "example", name: "示例", interval: 2 * MIN, spec: { kind: "rss", url: FEED }, ...over })
}

describe("运行时注册表", () => {
  it("内置源 + 已启用的用户源合并成一份；用户源 id 是 user:<slug>", async () => {
    const w = await setup()
    await add(w)
    const { sources, getters } = await w.registry.snapshot()
    expect(Object.keys(sources).sort()).toEqual(["hn", "user:example"])
    expect(sources["user:example"]).toEqual({ interval: 2 * MIN })
    expect(typeof getters["user:example"]).toBe("function")
    expect(getters.hn).toBe(w.builtin)
  })

  it("describe：内置源给显示名与分类，用户源含停用的；redirect 别名不列", async () => {
    const w = await setup()
    const registry = createRegistry({
      builtinSources: { hn: { interval: MIN, name: "Hacker News", title: "热门", column: "tech" }, alias: { interval: MIN, redirect: "hn" as any, name: "别名" }, plain: { interval: MIN } },
      builtinGetters: {},
      store: w.store,
      fetchText: w.fetchText,
      log: quiet,
    })
    await add(w, { category: "我的" })
    await w.service.update("example", { enabled: false })
    expect(await registry.describe()).toEqual([
      { id: "hn", name: "Hacker News 热门", category: "tech", builtin: true, enabled: true },
      { id: "plain", name: "plain", category: "", builtin: true, enabled: true },
      { id: "user:example", name: "示例", category: "我的", builtin: false, enabled: false },
    ])
  })

  it("停用的用户源不进快照；重新启用又回来", async () => {
    const w = await setup()
    await add(w)
    await w.service.update("example", { enabled: false })
    expect(Object.keys((await w.registry.snapshot()).sources)).toEqual(["hn"])
    await w.service.update("example", { enabled: true })
    expect(Object.keys((await w.registry.snapshot()).sources)).toContain("user:example")
  })

  it("内置源占用 user: 命名空间时拒绝启动，不静默覆盖", async () => {
    const w = await setup()
    expect(() => createRegistry({ builtinSources: { "user:x": { interval: 1 } }, builtinGetters: {}, store: w.store, fetchText: w.fetchText })).toThrow(/命名空间/)
  })

  it("读不到用户源时内置源照常；库里坏掉的一行不影响其余", async () => {
    const w = await setup()
    await add(w)
    await w.db.prepare(`INSERT INTO user_sources VALUES ('broken','x','',600000,1,'{not json',1,1)`).run()
    expect(Object.keys((await w.registry.snapshot()).sources).sort()).toEqual(["hn", "user:example"])
    const failing = createRegistry({ builtinSources: { hn: { interval: 1 } }, builtinGetters: { hn: async () => [] }, store: { list: async () => {
      throw new Error("db down")
    } } as any, fetchText: w.fetchText, log: quiet })
    expect(Object.keys((await failing.snapshot()).sources)).toEqual(["hn"])
  })
})

describe("采集器从注册表取源：不重建、不重启", () => {
  it("加一个用户源后下一轮就采到；内置源行为不变", async () => {
    const w = await setup()
    const first = await w.collector.tick()
    expect(first.succeeded).toEqual(["hn"])
    await add(w)
    w.advance(MIN) // 下一个 tick：内置源没到期，新加的用户源从未抓过
    const second = await w.collector.tick()
    expect(second.due).toEqual(["user:example"])
    expect(second.succeeded).toEqual(["user:example"])
    const items = await w.db.prepare(`SELECT item_id, title FROM items WHERE source_id = 'user:example' ORDER BY item_id`).all() as any[]
    expect(items).toHaveLength(8)
    expect(items[0].title).toBe("新闻 0")
    expect(w.builtin).toHaveBeenCalledTimes(1)
  })

  it("停用后不再采集，历史观测与条目保留；重新启用后继续", async () => {
    const w = await setup()
    await add(w)
    await w.collector.tick()
    const count = async (table: string) => ((await w.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE source_id = 'user:example'`).all()) as any[])[0].n
    const [obs, items] = [await count("observations"), await count("items")]
    expect(obs).toBe(8)

    await w.service.update("example", { enabled: false })
    const feedCalls = () => w.calls.filter(u => u === FEED).length
    const before = feedCalls()
    w.advance(5 * MIN)
    const tick = await w.collector.tick()
    expect(tick.due).not.toContain("user:example")
    expect(feedCalls()).toBe(before)
    expect([await count("observations"), await count("items")]).toEqual([obs, items])

    await w.service.update("example", { enabled: true })
    w.advance(5 * MIN)
    expect((await w.collector.tick()).succeeded).toContain("user:example")
    expect(await count("observations")).toBe(obs + 8)
  })

  it("用户源失败走与内置源同一套健康记录，且不影响别的源", async () => {
    const w = await setup({}) // 没有任何页面：用户源抓取必然失败
    await add(w)
    const t = await w.collector.tick()
    expect(t.succeeded).toEqual(["hn"])
    expect(t.failed[0].sourceId).toBe("user:example")
    const health = (await w.service.get("example")).health
    expect(health?.consecutiveFailures).toBe(1)
    expect(health?.lastError).toMatch(/404/)
  })

  it("删除用户源：配置与健康记录没了，历史观测保留", async () => {
    const w = await setup()
    await add(w)
    await w.collector.tick()
    await w.service.remove("example")
    expect(await w.service.list()).toEqual([])
    const rows = await w.db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE source_id = 'user:example'`).all() as any[]
    expect(rows[0].n).toBe(8)
    const health = await w.db.prepare(`SELECT COUNT(*) AS n FROM source_health WHERE source_id = 'user:example'`).all() as any[]
    expect(health[0].n).toBe(0)
  })
})
