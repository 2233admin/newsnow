import { describe, expect, it } from "vitest"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { memoryStore } from "./helpers"
import { buildPatrolReport, issueBody, openIssues } from "#/collector/patrol"
import type { PatrolSourceMeta, RunGh } from "#/collector/patrol"
import { readEnabledUserSources } from "#/registry/patrol-sources"
import { UserSourceStore } from "#/registry/store"

const MIN = 60_000
const NOW = Date.UTC(2026, 10, 21, 15, 0, 0)
const builtin: Record<string, PatrolSourceMeta> = { hn: { name: "Hacker News", interval: 10 * MIN } }

async function world() {
  const { db, store } = await memoryStore()
  const users = new UserSourceStore(db)
  await users.init()
  const add = (slug: string, enabled: boolean, interval = 30 * MIN) =>
    users.insert({ slug, name: `名 ${slug}`, category: "财经", interval, enabled, spec: { kind: "rss", url: `https://${slug}.example/rss` } }, NOW)
  return { db, store, add }
}

async function fail(store: Awaited<ReturnType<typeof memoryStore>>["store"], id: string, n: number, from: number) {
  for (let i = 0; i < n; i++) await store.recordFailure(id, from + i * 30 * MIN, new Error("HTTP 403"))
}

describe("巡检覆盖已启用的用户源", () => {
  it("读出已启用的用户源（键是 user:<slug>，带名称与间隔），停用的不在其中", async () => {
    const w = await world()
    await w.add("preset-a", true, 30 * MIN)
    await w.add("preset-b", false)
    expect(await readEnabledUserSources(w.db)).toEqual({ "user:preset-a": { name: "名 preset-a", interval: 30 * MIN } })
  })

  it("库里还没有 user_sources 表：返回空，且不建表、不改库", async () => {
    const db = createDatabase(sqlite({ name: ":memory:" }))
    expect(await readEnabledUserSources(db)).toEqual({})
    expect(await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'user_sources'").get()).toBeUndefined()
  })

  it("连续失败的用户源进 failing，没抓过的进 pending，健康的计入 okCount，停用的不出现", async () => {
    const w = await world()
    await w.add("down", true)
    await w.add("good", true)
    await w.add("fresh", true)
    await w.add("off", false)
    await w.store.recordSuccess("hn", NOW - MIN, 10)
    await w.store.recordSuccess("user:down", NOW - 6 * 60 * MIN, 5)
    await fail(w.store, "user:down", 8, NOW - 5 * 60 * MIN)
    await w.store.recordSuccess("user:good", NOW - MIN, 5)
    // 停用的源在 source_health 里残留着旧的连续失败记录：不该被报
    await fail(w.store, "user:off", 20, NOW - 10 * 60 * MIN)

    const sources = { ...builtin, ...await readEnabledUserSources(w.db) }
    const report = buildPatrolReport(await w.store.getHealth(), sources, NOW)
    expect(report.failing.map(f => f.sourceId)).toEqual(["user:down"])
    expect(report.failing[0]).toMatchObject({ name: "名 down", intervalMinutes: 30, consecutiveFailures: 8 })
    expect(report.pending).toEqual(["user:fresh"])
    expect(report.okCount).toBe(2)
    expect(report.unhealthy).toBe(true)

    // 对照：只用内置源（这个功能之前的行为）看不到任何用户源
    const before = buildPatrolReport(await w.store.getHealth(), builtin, NOW)
    expect(before.failing).toEqual([])
    expect(before.pending).toEqual([])
  })

  it("用户源的 issue：标题带 user: id，正文给的是改地址或停用，不是改适配器代码", async () => {
    const w = await world()
    await w.add("down", true)
    await w.store.recordSuccess("hn", NOW - MIN, 10)
    await w.store.recordSuccess("user:down", NOW - 6 * 60 * MIN, 5)
    await fail(w.store, "user:down", 8, NOW - 5 * 60 * MIN)
    const report = buildPatrolReport(await w.store.getHealth(), { ...builtin, ...await readEnabledUserSources(w.db) }, NOW)
    const body = issueBody(report.failing[0], report)
    expect(body).toContain("用户订阅源")
    expect(body).not.toContain("server/sources/")

    const calls: string[][] = []
    const runGh: RunGh = async (args) => {
      calls.push(args)
      return args.some(a => a.includes("/labels/")) ? "{}" : ""
    }
    const { actions } = await openIssues(report, { repo: "o/r", label: "area:news", dryRun: true, runGh })
    expect(actions).toEqual([expect.objectContaining({ sourceId: "user:down", action: "would-create", title: expect.stringMatching(/^\[信源巡检\] user:down 名 down /) })])
  })

  it("内置源的 issue 正文不变", () => {
    const body = issueBody({ sourceId: "hn", name: "HN", title: null, intervalMinutes: 10, consecutiveFailures: 9, lastSuccessAt: null, minutesSinceLastSuccess: null, lastError: "x", lastErrorAt: NOW }, { generatedAtIso: "x", thresholds: { minFailures: 5, minFailingMinutes: 60, collectorStalledMinutes: 15, massFailureRatio: 0.5, massFailureMinSources: 3 } })
    expect(body).toContain("server/sources/")
    expect(body).not.toContain("用户订阅源")
  })
})
