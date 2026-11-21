/**
 * MCP 入口的端到端：用官方 SDK 的客户端真连 /mcp（Streamable HTTP），
 * 经 MCP 加一个源 → 用户源列表接口立刻能看到 → 按审计撤销后消失；其余入口规则与 HTTP 一致。
 */
import http from "node:http"
import type { AddressInfo } from "node:net"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createApp, createError, createEventStream, createRouter, defineEventHandler, getHeader, getQuery, getRouterParam, readBody, setResponseHeader, setResponseStatus, toNodeListener } from "h3"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { T0, row } from "../feed/helpers"

Object.assign(globalThis, { defineEventHandler, createError, readBody, getQuery, getHeader, getRouterParam, setResponseHeader, setResponseStatus, createEventStream })
vi.mock("#/getters", () => ({ getters: {} }))

const { default: mcpRoute } = await import("../../server/routes/mcp")
const { default: listGet } = await import("#/api/collector/sources/index.get")
const { default: auditGet } = await import("#/api/collector/audit/index.get")
const { getObservationStore } = await import("#/collector/runtime")

let server: http.Server
let port: number
beforeAll(async () => {
  const db = createDatabase(sqlite({ name: ":memory:" }))
  vi.stubGlobal("useDatabase", () => db)
  const router = createRouter()
  router.use("/mcp", mcpRoute)
  router.get("/api/collector/sources", listGet)
  router.get("/api/collector/audit", auditGet)
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

const base = () => `http://127.0.0.1:${port}`
async function connect(actor?: string) {
  const client = new Client({ name: "test-agent", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: actor ? { headers: { "X-Actor": actor } } : undefined }))
  return client
}
const text = (res: any) => (res.content as { type: string, text: string }[])[0].text
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args })
  return { res, data: res.isError || text(res).startsWith("<") ? text(res) : JSON.parse(text(res)) }
}
const getJson = async (path: string) => await (await fetch(`${base()}${path}`)).json() as any

const SPEC = { kind: "rss", url: "https://feed.example/rss" }

describe("mCP 入口（官方 SDK 客户端）", () => {
  it("工具清单：查询 + 全部动作 + 撤销", async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      "add_source",
      "export_sources_opml",
      "import_sources_opml",
      "list_audit",
      "list_sources",
      "preview_source",
      "query_feed",
      "remove_source",
      "set_source_category",
      "set_source_enabled",
      "set_source_interval",
      "undo",
      "update_source",
    ])
    expect(tools.find(t => t.name === "remove_source")?.annotations?.destructiveHint).toBe(true)
    expect(tools.find(t => t.name === "query_feed")?.annotations?.readOnlyHint).toBe(true)
    await client.close()
  })

  it("agent 经 MCP 加源 → 用户源列表接口立刻看到 → 审计里是 mcp 与调用方名 → 按审计撤销后消失", async () => {
    const client = await connect("claude-agent")
    expect((await getJson("/api/collector/sources")).sources).toEqual([])

    const added = await call(client, "add_source", { name: "MCP 加的", slug: "via-mcp", category: "科技", spec: SPEC })
    expect(added.data).toMatchObject({ id: "user:via-mcp", name: "MCP 加的", auditId: expect.any(Number) })
    // 用户源列表（HTTP 入口）立刻就有
    expect((await getJson("/api/collector/sources")).sources.map((s: any) => s.id)).toEqual(["user:via-mcp"])

    const audit = (await getJson("/api/collector/audit")).records[0]
    expect(audit).toMatchObject({ id: added.data.auditId, entry: "mcp", actor: "claude-agent", action: "source.add" })

    // 其余动作
    expect((await call(client, "set_source_enabled", { slug: "via-mcp", enabled: false })).data.enabled).toBe(false)
    expect((await call(client, "set_source_category", { slug: "via-mcp", category: "财经" })).data.category).toBe("财经")
    expect((await call(client, "set_source_interval", { slug: "via-mcp", interval: 300_000 })).data.interval).toBe(300_000)
    expect((await call(client, "list_sources")).data.sources[0]).toMatchObject({ enabled: false, category: "财经", interval: 300_000 })

    // 按审计撤销加源那一步要先撤销后面三步（现状必须正好是那条记录改出来的）
    const refused = await call(client, "undo", { auditId: added.data.auditId })
    expect(refused.res.isError).toBe(true)
    expect(refused.data).toContain("之后又被改过")
    for (const rec of (await call(client, "list_audit", { limit: 3 })).data.records) await call(client, "undo", { auditId: rec.id })
    const undone = await call(client, "undo", { auditId: added.data.auditId })
    expect(undone.data).toMatchObject({ action: "audit.undo", undoOf: added.data.auditId, entry: "mcp", actor: "claude-agent" })
    expect((await getJson("/api/collector/sources")).sources).toEqual([])
    await client.close()
  })

  it("query_feed：返回入库的条目；标的筛选是真的，坏格式作为工具失败返回", async () => {
    const store = await getObservationStore()
    await store.recordObservations("jin10", [row("m1", { title: "黄金 突破" }), row("m2", { title: "原油 回落" })], T0)
    const client = await connect()
    const q = await call(client, "query_feed", { q: "黄金", source: "jin10" })
    expect(q.data.items.map((i: any) => i.itemId)).toEqual(["m1"])
    expect(q.data.latestSeq).toBeGreaterThan(0)
    await store.recordObservations("jin10", [row("m3", { title: "贵州茅台公告回购股份" })], T0 + 1)
    const sym = await call(client, "query_feed", { symbol: "600519.XSHG" })
    expect(sym.data.items.map((i: any) => [i.itemId, i.symbols])).toEqual([["m3", ["600519.XSHG"]]])
    expect(sym.data).not.toHaveProperty("unimplemented")
    const bad = await client.callTool({ name: "query_feed", arguments: { symbol: "600519" } })
    expect(bad.isError).toBe(true)
    const paged = await call(client, "query_feed", { limit: 1 })
    expect(paged.data.nextCursor).toBeTruthy()
    await client.close()
  })

  it("校验不通过：作为工具失败结果返回（模型能看见原因），不写审计", async () => {
    const client = await connect()
    const before = (await getJson("/api/collector/audit")).records.length
    const bad = await call(client, "add_source", { name: "坏的", spec: { kind: "rss", url: "ftp://x" } })
    expect(bad.res.isError).toBe(true)
    expect(bad.data).toContain("只支持 http 或 https")
    const noSource = await call(client, "remove_source", { slug: "nope" })
    expect(noSource.data).toContain("404")
    expect((await getJson("/api/collector/audit")).records).toHaveLength(before)
    await client.close()
  })

  it("导入导出：export 的文本能 import 回来，一次导入一条审计", async () => {
    const client = await connect("importer")
    await call(client, "add_source", { name: "导出用", slug: "exp", spec: SPEC })
    const xml = (await call(client, "export_sources_opml")).data as string
    await call(client, "remove_source", { slug: "exp" })
    const imported = await call(client, "import_sources_opml", { opml: xml })
    expect(imported.data).toMatchObject({ imported: ["user:exp"], auditId: expect.any(Number) })
    expect((await getJson("/api/collector/sources")).sources.map((s: any) => s.id)).toEqual(["user:exp"])
    await client.close()
  })
})

describe("mCP 入口的访问控制（同用户源接口）", () => {
  function raw(method: string, headers: Record<string, string>, body?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: "/mcp", headers }, (res) => {
        res.resume()
        resolve(res.statusCode!)
      })
      req.on("error", reject)
      req.end(body)
    })
  }
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } })
  const JSON_H = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" }

  it("重绑定的 Host、跨站 Origin、Sec-Fetch-Site: cross-site 都 403；非 JSON 的 POST 415；GET 与 DELETE 405", async () => {
    expect(await raw("POST", { ...JSON_H, Host: "attacker-rebind.example" }, init)).toBe(403)
    expect(await raw("POST", { ...JSON_H, Origin: "https://evil.example" }, init)).toBe(403)
    expect(await raw("POST", { ...JSON_H, "Sec-Fetch-Site": "cross-site" }, init)).toBe(403)
    expect(await raw("POST", { "Content-Type": "text/plain" }, init)).toBe(415)
    expect(await raw("GET", { Accept: "text/event-stream" })).toBe(405)
    expect(await raw("DELETE", {})).toBe(405)
    expect(await raw("POST", JSON_H, init)).toBe(200)
  })
})
