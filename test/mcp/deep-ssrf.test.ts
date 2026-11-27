/**
 * 独立审 M3：USER_SOURCES_ALLOW_PRIVATE=true（给自建 RSSHub 放行内网）时，深读抓原文仍然不能打内网。
 * 真起两个本机 HTTP 服务：假「内网页面」（条目链接指向它）与假模型上游；走真实的 getEnrichRuntime 装配。
 */
import http from "node:http"
import type { AddressInfo } from "node:net"
import process from "node:process"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { T0, row } from "../feed/helpers"

vi.mock("#/getters", () => ({ getters: {} }))

const SECRET = "内网管理后台的机密正文"
let internal: http.Server
let internalHits = 0
let llmUp: http.Server
const prompts: string[] = []

beforeAll(async () => {
  internal = http.createServer((_req, res) => {
    internalHits++
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(`<html><body><article>${`<p>${SECRET}，这一段足够长，用来通过「太短不当原文」的检查，并且里面有内网才有的内容。</p>`.repeat(6)}</article></body></html>`)
  })
  await new Promise<void>(r => internal.listen(0, "127.0.0.1", r))
  llmUp = http.createServer((req, res) => {
    let body = ""
    req.on("data", c => (body += c))
    req.on("end", () => {
      prompts.push(body)
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "摘要", keyPoints: [], entities: [], caveats: [] }) } }] }))
    })
  })
  await new Promise<void>(r => llmUp.listen(0, "127.0.0.1", r))
  Object.assign(process.env, {
    USER_SOURCES_ALLOW_PRIVATE: "true",
    ENRICH_LLM_PROVIDER: "openai",
    ENRICH_LLM_API_KEY: "sk-test-ssrf-0000000000",
    ENRICH_LLM_MODEL: "m",
    ENRICH_LLM_BASE_URL: `http://127.0.0.1:${(llmUp.address() as AddressInfo).port}/v1`,
  })
  const db = createDatabase(sqlite({ name: ":memory:" }))
  vi.stubGlobal("useDatabase", () => db)
})
afterAll(async () => {
  await new Promise(r => internal.close(r))
  await new Promise(r => llmUp.close(r))
})

describe("独立审 M3：深读抓原文固定不放行内网，与 USER_SOURCES_ALLOW_PRIVATE 无关", () => {
  it("开着 USER_SOURCES_ALLOW_PRIVATE，条目链接指向本机内网页面：深读不去抓，正文不进提示词，basis = title", async () => {
    const { getObservationStore } = await import("#/collector/runtime")
    const { getEnrichRuntime } = await import("#/enrich/runtime")
    const { readNetPolicy } = await import("#/registry/net")
    // 前提成立：用户源的策略确实放行了内网
    expect(readNetPolicy(process.env).allowPrivate).toBe(true)
    const store = await getObservationStore()
    const url = `http://127.0.0.1:${(internal.address() as AddressInfo).port}/admin/secret`
    await store.recordObservations("jin10", [row("evil", { title: "某恶意源把条目链接设成了内网地址的一条新闻", url })], T0)
    const r = await (await getEnrichRuntime()).deep.read(1)
    expect(r).toMatchObject({ status: "ok", basis: "title" })
    expect(internalHits).toBe(0)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain(SECRET)
    expect(prompts[0]).toContain("没有抓到")
  })
})
