/**
 * 独立审 S7 的端到端：真起假模型上游 + 真的 HTTP / MCP 入口（h3 + 同一套动作层）。
 * - 真的调了模型的深读（HTTP 与 MCP 两个入口）各写一条审计（deep.read），带入口与 X-Actor；缓存命中不写；
 * - 审计里的 deep.read 不能被撤销（没有可撤销的改动，409）；
 * - 每分钟上限到了回 429 + Retry-After，MCP 里是工具失败结果。
 */
import http from "node:http"
import type { AddressInfo } from "node:net"
import process from "node:process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createApp, createError, createEventStream, createRouter, defineEventHandler, getHeader, getQuery, getRouterParam, readBody, setResponseHeader, setResponseStatus, toNodeListener } from "h3"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { T0, row } from "../feed/helpers"

Object.assign(globalThis, { defineEventHandler, createError, readBody, getQuery, getHeader, getRouterParam, setResponseHeader, setResponseStatus, createEventStream })
vi.mock("#/getters", () => ({ getters: {} }))

let upstream: http.Server
let upstreamHits = 0
let server: http.Server
let port: number
const base = () => `http://127.0.0.1:${port}`

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    upstreamHits++
    req.resume()
    req.on("end", () => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "摘要", keyPoints: ["要点"], entities: [], caveats: [] }) } }] }))
    })
  })
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r))
  Object.assign(process.env, {
    ENRICH_LLM_PROVIDER: "openai",
    ENRICH_LLM_API_KEY: "sk-test-audit-0000000000",
    ENRICH_LLM_MODEL: "m",
    ENRICH_LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
    ENRICH_DEEP_FETCH_PAGE: "false",
    ENRICH_DEEP_MAX_PER_MINUTE: "3",
  })
  const db = createDatabase(sqlite({ name: ":memory:" }))
  vi.stubGlobal("useDatabase", () => db)
  const { default: mcpRoute } = await import("../../server/routes/mcp")
  const { default: feedDeepGet } = await import("#/api/feed/deep.get")
  const { default: auditGet } = await import("#/api/collector/audit/index.get")
  const router = createRouter()
  router.use("/mcp", mcpRoute)
  router.get("/api/feed/deep", feedDeepGet)
  router.get("/api/collector/audit", auditGet)
  const app = createApp()
  app.use(router)
  server = http.createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await new Promise(resolve => upstream.close(resolve))
})

const text = (res: unknown) => (res as { content: { text: string }[] }).content[0].text

describe("独立审 S7：深读进审计、每分钟上限回 429", () => {
  it("hTTP 与 MCP 各读一条写审计（带入口与 X-Actor）；缓存命中不写；deep.read 不能撤销；超过每分钟上限回 429 + Retry-After", async () => {
    const { getObservationStore } = await import("#/collector/runtime")
    const store = await getObservationStore()
    await store.recordObservations("jin10", ["一", "二", "三", "四"].map((n, i) => row(`k${i}`, { title: `第${n}条互不相同的财经快讯：某公司披露${i * 7919}号公告并调整经营计划` })), T0)
    const audit = async () => ((await (await fetch(`${base()}/api/collector/audit`)).json()) as { records: { id: number, entry: string, actor: string | null, action: string, summary: string, changes: unknown[] }[] }).records

    expect(await audit()).toEqual([])
    // HTTP：第一次真的调模型，第二次命中缓存
    const h1 = await (await fetch(`${base()}/api/feed/deep?seq=1`, { headers: { "x-actor": "page-1" } })).json()
    expect(h1).toMatchObject({ status: "ok", cached: false })
    expect(await (await fetch(`${base()}/api/feed/deep?seq=1`)).json()).toMatchObject({ cached: true })
    expect(upstreamHits).toBe(1)
    let recs = await audit()
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ entry: "http", actor: "page-1", action: "deep.read", changes: [] })
    expect(recs[0].summary).toContain("seq=1")

    // MCP
    const client = new Client({ name: "audit-test", version: "1.0.0" })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers: { "x-actor": "agent-7" } } }))
    const m = await client.callTool({ name: "read_item_deep", arguments: { seq: 2 } })
    expect(JSON.parse(text(m))).toMatchObject({ status: "ok", cached: false })
    await client.callTool({ name: "read_item_deep", arguments: { seq: 2 } }) // 命中缓存
    recs = await audit()
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({ entry: "mcp", actor: "agent-7", action: "deep.read" })
    expect(recs[0].summary).toContain("seq=2")

    // 撤销 deep.read：没有可撤销的改动
    const undo = await client.callTool({ name: "undo", arguments: { auditId: recs[0].id } })
    expect(undo.isError).toBe(true)
    expect(text(undo)).toContain("没有可撤销的")
    expect(await audit()).toHaveLength(2) // 撤销没有留下记录

    // 第 3 次未命中放行，第 4 次回 429
    expect(((await (await fetch(`${base()}/api/feed/deep?seq=3`)).json()) as { status: string }).status).toBe("ok")
    const over = await fetch(`${base()}/api/feed/deep?seq=4`)
    expect(over.status).toBe(429)
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
    expect(upstreamHits).toBe(3) // 被拒的没有调上游
    const mcpOver = await client.callTool({ name: "read_item_deep", arguments: { seq: 4 } })
    expect(mcpOver.isError).toBe(true)
    expect(text(mcpOver)).toContain("429")
    // 被拒的不写审计；缓存命中仍然放行
    expect(await audit()).toHaveLength(3)
    expect(await (await fetch(`${base()}/api/feed/deep?seq=1`)).json()).toMatchObject({ cached: true })
    await client.close()
  })
})
