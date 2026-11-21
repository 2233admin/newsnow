/**
 * HTTP 入口走动作层：改动写审计（含 X-Actor），能按审计撤销；审计接口同样只给本机（真 HTTP）。
 */
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createApp, createError, createRouter, defineEventHandler, getHeader, getQuery, getRouterParam, readBody, setResponseHeader, setResponseStatus, toNodeListener } from "h3"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"

Object.assign(globalThis, { defineEventHandler, createError, readBody, getQuery, getHeader, getRouterParam, setResponseHeader, setResponseStatus })
vi.mock("#/getters", () => ({ getters: {} }))

const { default: listGet } = await import("#/api/collector/sources/index.get")
const { default: createPost } = await import("#/api/collector/sources/index.post")
const { default: patch } = await import("#/api/collector/sources/[slug].patch")
const { default: del } = await import("#/api/collector/sources/[slug].delete")
const { default: auditGet } = await import("#/api/collector/audit/index.get")
const { default: undoPost } = await import("#/api/collector/audit/[id]/undo.post")

let server: http.Server
let port: number
beforeAll(async () => {
  const db = createDatabase(sqlite({ name: ":memory:" }))
  vi.stubGlobal("useDatabase", () => db)
  const router = createRouter()
  router.get("/api/collector/sources", listGet)
  router.post("/api/collector/sources", createPost)
  router.patch("/api/collector/sources/:slug", patch)
  router.delete("/api/collector/sources/:slug", del)
  router.get("/api/collector/audit", auditGet)
  router.post("/api/collector/audit/:id/undo", undoPost)
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

function call(method: string, path: string, opts: { headers?: Record<string, string>, body?: unknown } = {}): Promise<{ status: number, json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: opts.headers }, (res) => {
      let body = ""
      res.on("data", c => (body += c))
      res.on("end", () => resolve({ status: res.statusCode!, json: body ? JSON.parse(body) : undefined }))
    })
    req.on("error", reject)
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body))
  })
}
const JSON_H = { "Content-Type": "application/json" }
const SPEC = { kind: "rss", url: "https://feed.example/rss" }

describe("hTTP 入口：改动写审计、可撤销", () => {
  it("新增 → 审计里有入口 http 与 X-Actor → 撤销后列表里消失 → 重做又回来", async () => {
    const created = await call("POST", "/api/collector/sources", { headers: { ...JSON_H, "X-Actor": "settings-page" }, body: { name: "示例", slug: "demo", spec: SPEC } })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ id: "user:demo", auditId: 1 })

    const audit = await call("GET", "/api/collector/audit")
    expect(audit.json.records).toHaveLength(1)
    expect(audit.json.records[0]).toMatchObject({ id: 1, entry: "http", actor: "settings-page", action: "source.add" })
    expect(audit.json.records[0].changes[0]).toMatchObject({ slug: "demo", before: null, after: { name: "示例" } })

    const undo = await call("POST", "/api/collector/audit/1/undo", { headers: JSON_H, body: {} })
    expect(undo.status).toBe(200)
    expect(undo.json).toMatchObject({ id: 2, action: "audit.undo", undoOf: 1 })
    expect((await call("GET", "/api/collector/sources")).json.sources).toEqual([])

    const redo = await call("POST", "/api/collector/audit/2/undo", { headers: JSON_H, body: {} })
    expect(redo.status).toBe(200)
    expect((await call("GET", "/api/collector/sources")).json.sources.map((s: any) => s.id)).toEqual(["user:demo"])
  })

  it("pATCH 与 DELETE 也写审计；已撤销的再撤销 409；不存在 404；id 不是数字 400", async () => {
    const patched = await call("PATCH", "/api/collector/sources/demo", { headers: JSON_H, body: { enabled: false } })
    expect(patched.json).toMatchObject({ enabled: false, auditId: expect.any(Number) })
    const removed = await call("DELETE", "/api/collector/sources/demo")
    expect(removed.json).toEqual({ ok: true, auditId: patched.json.auditId + 1 })
    const list = await call("GET", "/api/collector/audit?limit=2")
    expect(list.json.records.map((r: any) => r.action)).toEqual(["source.remove", "source.update"])
    const paged = await call("GET", `/api/collector/audit?limit=1&before=${list.json.records[0].id}`)
    expect(paged.json.records[0].action).toBe("source.update")
    expect((await call("POST", `/api/collector/audit/${removed.json.auditId}/undo`, { headers: JSON_H, body: {} })).status).toBe(200)
    expect((await call("POST", `/api/collector/audit/${removed.json.auditId}/undo`, { headers: JSON_H, body: {} })).status).toBe(409)
    expect((await call("POST", "/api/collector/audit/9999/undo", { headers: JSON_H, body: {} })).status).toBe(404)
    expect((await call("POST", "/api/collector/audit/abc/undo", { headers: JSON_H, body: {} })).status).toBe(400)
    expect((await call("GET", "/api/collector/audit?limit=x")).status).toBe(400)
  })

  it("审计接口的访问检查与用户源接口一致：重绑定 Host、跨站、非 JSON 的撤销都被拒", async () => {
    expect((await call("GET", "/api/collector/audit", { headers: { Host: "attacker-rebind.example" } })).status).toBe(403)
    expect((await call("POST", "/api/collector/audit/1/undo", { headers: { ...JSON_H, "Sec-Fetch-Site": "cross-site" }, body: {} })).status).toBe(403)
    expect((await call("POST", "/api/collector/audit/1/undo", { headers: { "Content-Type": "text/plain" }, body: {} })).status).toBe(415)
  })
})
