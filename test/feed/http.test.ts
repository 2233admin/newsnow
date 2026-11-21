/**
 * /api/feed 与 /api/feed/stream 的端到端（真 HTTP，handler 原样挂进 h3）：访问检查、查询、SSE 与 Last-Event-ID 续传。
 */
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createApp, createError, createEventStream, createRouter, defineEventHandler, getHeader, getQuery, toNodeListener } from "h3"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { T0, row } from "./helpers"

Object.assign(globalThis, { defineEventHandler, createError, getQuery, getHeader, createEventStream })
vi.mock("#/getters", () => ({ getters: {} }))

const { default: feedGet } = await import("#/api/feed/index.get")
const { default: streamGet } = await import("#/api/feed/stream.get")
const { getObservationStore } = await import("#/collector/runtime")

let server: http.Server
let port: number
beforeAll(async () => {
  const db = createDatabase(sqlite({ name: ":memory:" }))
  vi.stubGlobal("useDatabase", () => db)
  const router = createRouter()
  router.get("/api/feed", feedGet)
  router.get("/api/feed/stream", streamGet)
  const app = createApp()
  app.use(router)
  server = http.createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => {
  server.closeAllConnections()
  return new Promise(resolve => server.close(resolve))
})

const url = (path: string) => `http://127.0.0.1:${port}${path}`

/** fetch 不让改 Host，要伪造重绑定的 Host 只能用 node:http。 */
function rawGet(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume()
      resolve(res.statusCode!)
    })
    req.on("error", reject)
    req.end()
  })
}

interface Frame {
  id?: string
  event?: string
  data: string
}

/** 读 SSE：把流解析成帧，waitFor 等到满足条件为止。 */
async function sse(path: string, headers: Record<string, string> = {}) {
  const ctl = new AbortController()
  const res = await fetch(url(path), { headers, signal: ctl.signal })
  const frames: Frame[] = []
  const done = (async () => {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const raw = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const f: Frame = { data: "" }
          for (const line of raw.split("\n")) {
            if (line.startsWith("id: ")) f.id = line.slice(4)
            else if (line.startsWith("event: ")) f.event = line.slice(7)
            else if (line.startsWith("data: ")) f.data += line.slice(6)
          }
          frames.push(f)
        }
      }
    } catch {}
  })()
  return { res, frames, items: () => frames.filter(f => f.event === "item"), close: () => ctl.abort(), done }
}

describe("信息流的 HTTP 接口", () => {
  it("gET /api/feed：非本机的 Host、跨站的请求被拒（同用户源接口）", async () => {
    expect(await rawGet("/api/feed", { Host: "attacker-rebind.example" })).toBe(403)
    expect(await rawGet("/api/feed/stream", { Host: "attacker-rebind.example" })).toBe(403)
    expect(await rawGet("/api/feed", { "Sec-Fetch-Site": "cross-site" })).toBe(403)
    expect(await rawGet("/api/feed/stream", { Origin: "https://evil.example" })).toBe(403)
    expect(await rawGet("/api/feed", { "Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-site" })).toBe(200)
    expect((await fetch(url("/api/feed?limit=0"))).status).toBe(400)
    expect((await fetch(url("/api/feed?cursor=xx"))).status).toBe(400)
  })

  it("查询：入库的条目按排序键返回，limit 与 nextCursor 能翻页", async () => {
    const store = await getObservationStore()
    await store.recordObservations("jin10", Array.from({ length: 5 }, (_, i) => row(`q${i}`, { pubDate: T0 - i * 1000 })), T0)
    const first = await (await fetch(url("/api/feed?limit=2&source=jin10"))).json()
    expect(first.items.map((i: any) => i.itemId)).toEqual(["q0", "q1"])
    expect(first.nextCursor).toBeTruthy()
    const second = await (await fetch(url(`/api/feed?limit=2&source=jin10&cursor=${encodeURIComponent(first.nextCursor)}`))).json()
    expect(second.items.map((i: any) => i.itemId)).toEqual(["q2", "q3"])
    const sym = await (await fetch(url("/api/feed?symbol=600519"))).json()
    expect(sym).toMatchObject({ items: [], unimplemented: ["symbol"] })
  })

  it("sSE：新条目入库后推到；断线后带 Last-Event-ID 续上，不丢不重", async () => {
    const store = await getObservationStore()
    const head = (await (await fetch(url("/api/feed?limit=1"))).json()).latestSeq as number
    const a = await sse(`/api/feed/stream?lastEventId=${head}`)
    expect(a.res.status).toBe(200)
    expect(a.res.headers.get("content-type")).toContain("text/event-stream")
    await vi.waitFor(() => expect(a.frames.map(f => f.event)).toContain("ready"))
    await store.recordObservations("weibo", [row("s1"), row("s2")], T0 + 60_000)
    await vi.waitFor(() => expect(a.items()).toHaveLength(2))
    expect(a.items().map(f => JSON.parse(f.data).itemId)).toEqual(["s1", "s2"])
    expect(a.items().map(f => Number(f.id))).toEqual([head + 1, head + 2])
    expect(JSON.parse(a.items()[0].data)).toMatchObject({ sourceId: "weibo", seq: head + 1, sourceName: "微博 实时热搜" })

    // 断线；期间入库两条
    const lastId = a.items().at(-1)!.id!
    a.close()
    await a.done
    await store.recordObservations("weibo", [row("s3"), row("s4")], T0 + 120_000)
    // 带请求头 Last-Event-ID 重连（EventSource 自动重连时的做法）
    const b = await sse("/api/feed/stream", { "Last-Event-ID": lastId })
    await vi.waitFor(() => expect(b.items()).toHaveLength(2))
    await store.recordObservations("weibo", [row("s5")], T0 + 180_000)
    await vi.waitFor(() => expect(b.items()).toHaveLength(3))
    expect(b.items().map(f => JSON.parse(f.data).itemId)).toEqual(["s3", "s4", "s5"])
    expect(b.items().map(f => Number(f.id))).toEqual([head + 3, head + 4, head + 5])
    b.close()
    await b.done
  })

  it("sSE 筛选：只推订阅的来源", async () => {
    const store = await getObservationStore()
    const c = await sse("/api/feed/stream?source=jin10")
    await vi.waitFor(() => expect(c.frames.map(f => f.event)).toContain("ready"))
    await store.recordObservations("weibo", [row("t1")], T0 + 240_000)
    await store.recordObservations("jin10", [row("t2")], T0 + 240_001)
    await vi.waitFor(() => expect(c.items()).toHaveLength(1))
    expect(JSON.parse(c.items()[0].data).itemId).toBe("t2")
    c.close()
    await c.done
  })
})
