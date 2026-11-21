/**
 * 「只给本机」这道门的端到端测试（真 HTTP，经 node:http 才能随意设置 Host / Origin）。
 * 复现安全审的两个载荷：
 *  1. text/plain + 跨站 Origin 往 OPML 导入里注入源（CSRF，简单请求不需要预检）；
 *  2. Host: attacker-rebind.example 读列表（DNS 重绑定后与页面同源）。
 */
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createApp, createError, createRouter, defineEventHandler, getQuery, getRequestHeader, getRouterParam, readBody, readRawBody, setResponseHeader, setResponseStatus, toNodeListener } from "h3"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"

Object.assign(globalThis, { defineEventHandler, createError, readBody, readRawBody, getQuery, getRequestHeader, getRouterParam, setResponseHeader, setResponseStatus })
vi.mock("#/getters", () => ({ getters: {} }))

const { default: listGet } = await import("#/api/collector/sources/index.get")
const { default: createPost } = await import("#/api/collector/sources/index.post")
const { default: opmlPost } = await import("#/api/collector/sources/opml.post")
const { default: opmlGet } = await import("#/api/collector/sources/opml.get")
const { default: patch } = await import("#/api/collector/sources/[slug].patch")
const { default: del } = await import("#/api/collector/sources/[slug].delete")

const OPML = `<opml version="2.0" xmlns:katana="x"><body>
  <outline type="link" text="injected" url="https://a.example/api" katana:kind="json" katana:slug="injected"
    katana:spec="{&quot;kind&quot;:&quot;json&quot;,&quot;url&quot;:&quot;https://a.example/api&quot;,&quot;itemsPath&quot;:&quot;&quot;,&quot;fields&quot;:{&quot;title&quot;:&quot;t&quot;,&quot;url&quot;:&quot;u&quot;}}"/>
</body></opml>`

let server: http.Server
let port: number
let db: ReturnType<typeof createDatabase>

beforeAll(async () => {
  db = createDatabase(sqlite({ name: ":memory:" }))
  vi.stubGlobal("useDatabase", () => db)
  const router = createRouter()
  router.get("/api/collector/sources", listGet)
  router.post("/api/collector/sources", createPost)
  router.post("/api/collector/sources/opml", opmlPost)
  router.get("/api/collector/sources/opml", opmlGet)
  router.patch("/api/collector/sources/:slug", patch)
  router.delete("/api/collector/sources/:slug", del)
  const app = createApp()
  app.use(router)
  server = http.createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})
beforeEach(async () => {
  // 表在第一次请求时才建；还没建时没有东西可清
  await db.prepare("DELETE FROM user_sources").run().catch(() => {})
  afterAll(() => new Promise(resolve => server.close(resolve)))
})

function call(method: string, path: string, opts: { headers?: Record<string, string>, body?: string } = {}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: opts.headers }, (res) => {
      let body = ""
      res.on("data", c => (body += c))
      res.on("end", () => resolve({ status: res.statusCode!, body }))
    })
    req.on("error", reject)
    req.end(opts.body)
  })
}
const json = (extra: Record<string, string> = {}) => ({ "Content-Type": "application/json", ...extra })
const names = async () => (await db.prepare("SELECT slug FROM user_sources").all().catch(() => [])) as { slug: string }[]

describe("用户源接口的访问检查（真 HTTP）", () => {
  it("载荷 1：text/plain + 跨站 Origin 导入 OPML 被拒，库里没有注入的源", async () => {
    const r = await call("POST", "/api/collector/sources/opml", {
      headers: { "Content-Type": "text/plain", "Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site" },
      body: OPML,
    })
    expect(r.status).toBe(403)
    expect(await names()).toEqual([])
  })

  it("载荷 1 的变体：只有 text/plain、没有任何浏览器头，也被拒（写接口只收 application/json）", async () => {
    const r = await call("POST", "/api/collector/sources/opml", { headers: { "Content-Type": "text/plain" }, body: OPML })
    expect(r.status).toBe(415)
    expect(await names()).toEqual([])
  })

  it("载荷 2：Host 是重绑定域名时读不到列表与导出", async () => {
    for (const path of ["/api/collector/sources", "/api/collector/sources/opml"]) {
      const r = await call("GET", path, { headers: { Host: `attacker-rebind.example:${port}` } })
      expect(r.status, path).toBe(403)
    }
  })

  it("重绑定 Host 下 PATCH / DELETE 也被拒", async () => {
    const h = json({ Host: "attacker-rebind.example" })
    expect((await call("PATCH", "/api/collector/sources/x", { headers: h, body: "{}" })).status).toBe(403)
    expect((await call("DELETE", "/api/collector/sources/x", { headers: { Host: "attacker-rebind.example" } })).status).toBe(403)
  })

  it("跨站：Origin 不在白名单、Sec-Fetch-Site 为 cross-site 的请求都被拒（即使是 JSON）", async () => {
    const body = JSON.stringify({ opml: OPML })
    expect((await call("POST", "/api/collector/sources/opml", { headers: json({ Origin: "https://evil.example" }), body })).status).toBe(403)
    expect((await call("POST", "/api/collector/sources/opml", { headers: json({ Origin: "null" }), body })).status).toBe(403)
    expect((await call("POST", "/api/collector/sources/opml", { headers: json({ "Sec-Fetch-Site": "cross-site" }), body })).status).toBe(403)
    expect((await call("GET", "/api/collector/sources", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403)
    expect(await names()).toEqual([])
  })

  it("本机正常用法不受影响：无 Origin 的 curl、工作台所在的本机 Origin", async () => {
    expect((await call("GET", "/api/collector/sources")).status).toBe(200)
    expect((await call("GET", "/api/collector/sources", { headers: { "Origin": "http://localhost:5173", "Sec-Fetch-Site": "same-site" } })).status).toBe(200)
    const imported = await call("POST", "/api/collector/sources/opml", { headers: json(), body: JSON.stringify({ opml: OPML }) })
    expect(imported.status).toBe(200)
    expect(JSON.parse(imported.body).imported).toEqual(["user:injected"])
    expect((await names()).map(n => n.slug)).toEqual(["injected"])
  })
})
