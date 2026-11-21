/**
 * /api/s 与 /api/s/entire 的行为锁定（#2184 验收「原有 /api/s 接口行为不变」）。
 * 这些测试在采集器加入之前的代码上也是绿的：它们描述的是上游原有的「按需抓取 + 缓存」行为，
 * 采集器不得改变它，也不得被它触发。
 */
import { createApp, createError, createRouter, defineEventHandler, getQuery, readBody, toWebHandler } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { ObservationStore } from "#/collector/store"

// Nitro 会把 h3 的这几个函数自动导入到 server/ 下的文件；vitest.config.ts 的 h3 预设在这里没有生效，所以手动补上全局
Object.assign(globalThis, { defineEventHandler, getQuery, readBody, createError })

const getterMocks = vi.hoisted(() => ({ weibo: vi.fn(), jin10: vi.fn() }))
vi.mock("#/getters", () => ({ getters: getterMocks }))

const { default: sHandler } = await import("#/api/s/index")
const { default: entireHandler } = await import("#/api/s/entire.post")

const T0 = Date.UTC(2026, 10, 21, 12, 0, 0)
const MIN = 60_000
const news = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `${i}`, title: `标题${i}`, url: `u/${i}` }))

let db: ReturnType<typeof createDatabase>
let fetchSource: (query: string) => Promise<Response>
let fetchEntire: (body: unknown) => Promise<Response>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(T0)
  db = createDatabase(sqlite({ name: ":memory:" }))
  vi.stubGlobal("useDatabase", () => db)
  getterMocks.weibo.mockReset()
  getterMocks.jin10.mockReset()
  const router = createRouter()
  router.get("/api/s", sHandler)
  router.post("/api/s/entire", entireHandler)
  const app = createApp()
  app.use(router)
  const handle = toWebHandler(app)
  fetchSource = query => handle(new Request(`http://localhost/api/s${query}`))
  fetchEntire = body => handle(new Request("http://localhost/api/s/entire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("/api/s", () => {
  it("未知的源 id 返回 500，且不去抓", async () => {
    const res = await fetchSource("?id=no-such-source")
    expect(res.status).toBe(500)
    expect(getterMocks.weibo).not.toHaveBeenCalled()
  })

  it("没有缓存时现抓、最多返回 30 条、status 为 success，并写入缓存", async () => {
    getterMocks.weibo.mockResolvedValue(news(45))
    const res = await fetchSource("?id=weibo")
    const body = await res.json() as any
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ status: "success", id: "weibo", updatedTime: T0 })
    expect(body.items).toHaveLength(30)
    expect(getterMocks.weibo).toHaveBeenCalledTimes(1)
    const row = await db.prepare("SELECT id, updated, data FROM cache WHERE id = ?").get("weibo") as any
    expect(row.updated).toBe(T0)
    expect(JSON.parse(row.data)).toHaveLength(30)
  })

  it("缓存在源的 interval 之内：直接返回缓存，不再抓", async () => {
    getterMocks.weibo.mockResolvedValue(news(3))
    await fetchSource("?id=weibo")
    vi.setSystemTime(T0 + 1 * MIN) // weibo 的 interval 是 2 分钟
    const body = await (await fetchSource("?id=weibo")).json() as any
    expect(body).toMatchObject({ status: "success", updatedTime: T0 + 1 * MIN })
    expect(body.items).toHaveLength(3)
    expect(getterMocks.weibo).toHaveBeenCalledTimes(1)
  })

  it("超过 interval 但还在 TTL（30 分钟）内、没带 latest：返回缓存，status 为 cache，updatedTime 是缓存时间", async () => {
    getterMocks.weibo.mockResolvedValue(news(3))
    await fetchSource("?id=weibo")
    vi.setSystemTime(T0 + 10 * MIN)
    const body = await (await fetchSource("?id=weibo")).json() as any
    expect(body).toMatchObject({ status: "cache", updatedTime: T0 })
    expect(getterMocks.weibo).toHaveBeenCalledTimes(1)
  })

  it("超过 TTL：重新抓取并更新缓存", async () => {
    getterMocks.weibo.mockResolvedValueOnce(news(3)).mockResolvedValueOnce(news(5))
    await fetchSource("?id=weibo")
    vi.setSystemTime(T0 + 31 * MIN)
    const body = await (await fetchSource("?id=weibo")).json() as any
    expect(body).toMatchObject({ status: "success", updatedTime: T0 + 31 * MIN })
    expect(body.items).toHaveLength(5)
    expect(getterMocks.weibo).toHaveBeenCalledTimes(2)
  })

  it("抓取失败：有旧缓存就返回旧缓存（status 为 cache），没有就 500", async () => {
    getterMocks.weibo.mockRejectedValueOnce(new Error("upstream down"))
    const cold = await fetchSource("?id=weibo")
    expect(cold.status).toBe(500)

    getterMocks.weibo.mockResolvedValueOnce(news(2))
    await fetchSource("?id=weibo")
    vi.setSystemTime(T0 + 31 * MIN)
    getterMocks.weibo.mockRejectedValueOnce(new Error("upstream down"))
    const warm = await (await fetchSource("?id=weibo")).json() as any
    expect(warm).toMatchObject({ status: "cache" })
    expect(warm.items).toHaveLength(2)
  })

  it("抓到空列表时不覆盖缓存", async () => {
    getterMocks.weibo.mockResolvedValueOnce(news(2)).mockResolvedValueOnce([])
    await fetchSource("?id=weibo")
    vi.setSystemTime(T0 + 31 * MIN)
    const body = await (await fetchSource("?id=weibo")).json() as any
    expect(body.items).toEqual([])
    const row = await db.prepare("SELECT data FROM cache WHERE id = ?").get("weibo") as any
    expect(JSON.parse(row.data)).toHaveLength(2)
  })
})

describe("/api/s/entire", () => {
  it("返回请求的源在缓存里的内容，忽略未知的 id", async () => {
    getterMocks.weibo.mockResolvedValue(news(2))
    getterMocks.jin10.mockResolvedValue(news(4))
    await fetchSource("?id=weibo")
    await fetchSource("?id=jin10")
    const res = await fetchEntire({ sources: ["weibo", "jin10", "no-such-source"] })
    const body = await res.json() as any[]
    expect(body.map(b => [b.id, b.status, b.items.length]).sort()).toEqual([["jin10", "cache", 4], ["weibo", "cache", 2]])
  })
})

describe("采集器与 /api/s 互不触发", () => {
  it("请求 /api/s 不会往观测库里写任何东西", async () => {
    const store = new ObservationStore(db)
    await store.init()
    getterMocks.weibo.mockResolvedValue(news(3))
    await fetchSource("?id=weibo")
    expect(await db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 })
    expect(await db.prepare("SELECT COUNT(*) AS n FROM observations").get()).toEqual({ n: 0 })
  })
})

describe("cache.getEntire 参数化", () => {
  it("id 里带引号与 SQL 片段也只按字面匹配，不影响其他行；空列表返回空", async () => {
    const { Cache } = await import("#/database/cache")
    const cache = new Cache(db)
    await cache.init()
    await cache.set("weibo", news(1) as any)
    const evil = `x' or '1'='1`
    expect(await cache.getEntire([evil])).toEqual([])
    expect((await cache.getEntire([evil, "weibo"])).map(c => c.id)).toEqual(["weibo"])
    expect(await cache.getEntire([])).toEqual([])
  })
})
