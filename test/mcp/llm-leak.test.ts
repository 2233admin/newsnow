/**
 * 独立审 M2 的端到端：上游（网关 / 代理）在 401 正文里回显 Authorization 与 x-api-key 时，
 * 模型 key 不能出现在日志、GET /api/feed/deep 的响应、MCP read_item_deep 的返回里，批量标注一轮的结果里也不能有。
 * 真起一个假上游（本机 HTTP 服务），真走 createLlm → 标注 / 深读 → HTTP 与 MCP 入口。
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
import { logger } from "../../server/utils/logger"

Object.assign(globalThis, { defineEventHandler, createError, readBody, getQuery, getHeader, getRouterParam, setResponseHeader, setResponseStatus, createEventStream })
vi.mock("#/getters", () => ({ getters: {} }))

const KEY = "sk-SECRETKEY-1234567890-abcdef"
let upstream: http.Server
let upstreamHits = 0
let server: http.Server
let port: number
const logged: string[] = []
const spies: { mockRestore: () => void }[] = []

beforeAll(async () => {
  // 假上游：不管谁来，都在 401 正文里把收到的 Authorization / x-api-key 原样回显
  upstream = http.createServer((req, res) => {
    upstreamHits++
    res.statusCode = 401
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ error: { type: "authentication_error", message: `bad auth: ${req.headers.authorization} / ${req.headers["x-api-key"]}` } }))
  })
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r))
  Object.assign(process.env, {
    ENRICH_LLM_PROVIDER: "openai",
    ENRICH_LLM_API_KEY: KEY,
    ENRICH_LLM_MODEL: "m",
    ENRICH_LLM_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
    ENRICH_DEEP_FETCH_PAGE: "false",
    ENRICH_TAG_CATEGORIES: "*",
  })
  for (const m of ["warn", "error", "info", "debug", "log", "fail", "fatal", "trace", "success"] as const) {
    spies.push(vi.spyOn(logger, m).mockImplementation(((...args: unknown[]) => {
      logged.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    }) as never))
  }
  const db = createDatabase(sqlite({ name: ":memory:" }))
  vi.stubGlobal("useDatabase", () => db)
  const { default: mcpRoute } = await import("../../server/routes/mcp")
  const { default: feedDeepGet } = await import("#/api/feed/deep.get")
  const router = createRouter()
  router.use("/mcp", mcpRoute)
  router.get("/api/feed/deep", feedDeepGet)
  const app = createApp()
  app.use(router)
  server = http.createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  for (const s of spies) s.mockRestore()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await new Promise(resolve => upstream.close(resolve))
})

describe("独立审 M2：上游 401 回显 key 时，key 不出现在日志、深读接口与 MCP 的返回里", () => {
  it("批量标注一轮、HTTP 深读、MCP 深读：全程没有 key，也没有上游正文", async () => {
    const { getObservationStore } = await import("#/collector/runtime")
    const { getEnrichRuntime } = await import("#/enrich/runtime")
    const store = await getObservationStore()
    await store.recordObservations("jin10", [
      row("k1", { title: "贵州茅台：控股股东拟增持不低于 1 亿元，彰显长期发展信心" }),
      row("k2", { title: "宁德时代：海外工厂投产进度符合预期，二季度产能利用率继续提升" }),
    ], T0)

    // 1) 批量标注：调用失败 → 退避，错误进日志
    const runtime = await getEnrichRuntime()
    expect(runtime.tagger).not.toBeNull()
    const run = await runtime.tagger!.run()
    expect(run.error).toBeTruthy()
    expect(run.error).toContain("401")
    expect(JSON.stringify(run)).not.toContain(KEY)

    // 2) HTTP 深读
    const http1 = await (await fetch(`http://127.0.0.1:${port}/api/feed/deep?seq=1`)).text()
    expect(JSON.parse(http1)).toMatchObject({ status: "error", deep: null })
    expect(http1).toContain("HTTP 401")
    expect(http1).not.toContain(KEY)
    expect(http1).not.toContain("bad auth")

    // 3) MCP 深读
    const client = new Client({ name: "leak-test", version: "1.0.0" })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    // 另一条（同一条刚失败过会走 30 秒负缓存，不再碰上游）
    const res = await client.callTool({ name: "read_item_deep", arguments: { seq: 2 } })
    const body = (res.content as { text: string }[])[0].text
    expect(JSON.parse(body)).toMatchObject({ status: "error" })
    expect(body).not.toContain(KEY)
    expect(body).not.toContain("bad auth")
    await client.close()

    // 真的调到了上游（不是因为没调用才没泄露），且日志里确实记了点什么
    expect(upstreamHits).toBeGreaterThanOrEqual(3)
    expect(logged.some(l => l.includes("401"))).toBe(true)
    // 4) 日志
    expect(logged.join("\n")).not.toContain(KEY)
    expect(logged.join("\n")).not.toContain("bad auth")
  })
})
