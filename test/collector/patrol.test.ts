import { describe, expect, it } from "vitest"
import { memoryStore } from "./helpers"
import { ISSUE_TITLE_PREFIX, PATROL_DEFAULTS, buildPatrolReport, issueBody, issueTitle, openIssues } from "#/collector/patrol"
import type { PatrolSourceMeta, PatrolThresholds, RunGh } from "#/collector/patrol"

const MIN = 60_000
const NOW = Date.UTC(2026, 10, 21, 15, 0, 0)
const sources: Record<string, PatrolSourceMeta> = {
  good: { name: "好源", interval: 2 * MIN },
  down: { name: "挂了的源", title: "快讯", interval: 2 * MIN },
  blip: { name: "刚抖了一下", interval: 2 * MIN },
  slow: { name: "慢源", interval: 60 * MIN },
  fresh: { name: "新源", interval: 10 * MIN },
  alias: { name: "别名", interval: 10 * MIN, redirect: "good" },
}

/** 通过真实的观测库写入健康记录，再读出来喂给巡检，不手搓 HealthRecord */
async function healthFrom(plan: (store: Awaited<ReturnType<typeof memoryStore>>["store"]) => Promise<void>) {
  const { store } = await memoryStore()
  await plan(store)
  return await store.getHealth()
}

async function failTimes(store: Awaited<ReturnType<typeof memoryStore>>["store"], id: string, n: number, from: number, error = "HTTP 503") {
  for (let i = 0; i < n; i++) await store.recordFailure(id, from + i * 2 * MIN, new Error(error))
}

describe("buildPatrolReport", () => {
  it("连续失败够次数且够久的进 failing；失败少、或才断了一会儿的进 watching；没抓过的进 pending；redirect 不出现", async () => {
    const health = await healthFrom(async (store) => {
      await store.recordSuccess("good", NOW - 1 * MIN, 10)
      // down：3 小时前最后成功，之后连挂 90 次
      await store.recordSuccess("down", NOW - 180 * MIN, 10)
      await failTimes(store, "down", 90, NOW - 178 * MIN, "[GET] \"https://x.test/api\": 503 Service Unavailable")
      // blip：10 分钟前还成功，之后连挂 5 次（次数够，但时间不够久）
      await store.recordSuccess("blip", NOW - 10 * MIN, 10)
      await failTimes(store, "blip", 5, NOW - 8 * MIN)
      // slow：从没成功过，挂了 6 次
      await failTimes(store, "slow", 6, NOW - 6 * 60 * MIN)
      // 采集器仍在跑：最近有尝试
      await store.recordSuccess("good", NOW - 1 * MIN, 10)
    })
    const report = buildPatrolReport(health, sources, NOW)

    expect(report.failing.map(f => f.sourceId)).toEqual(["down", "slow"])
    expect(report.failing[0]).toMatchObject({
      sourceId: "down",
      name: "挂了的源",
      title: "快讯",
      consecutiveFailures: 90,
      minutesSinceLastSuccess: 180,
      intervalMinutes: 2,
    })
    expect(report.failing[1]).toMatchObject({ sourceId: "slow", minutesSinceLastSuccess: null })
    expect(report.watching.map(f => f.sourceId)).toEqual(["blip"])
    expect(report.pending).toEqual(["fresh"])
    expect(report.okCount).toBe(1)
    expect(report.collector.stalled).toBe(false)
    expect(report.unhealthy).toBe(true)
  })

  it("阈值恰好卡在边界：次数差 1 不报，次数够但差 1 分钟不报，都够就报", async () => {
    const run = async (failures: number, minutesAgo: number, thresholds: PatrolThresholds = PATROL_DEFAULTS) => {
      const health = await healthFrom(async (store) => {
        await store.recordSuccess("down", NOW - minutesAgo * MIN, 1)
        await failTimes(store, "down", failures, NOW - (minutesAgo - 1) * MIN)
      })
      return buildPatrolReport(health, { down: sources.down }, NOW, thresholds).failing.length
    }
    expect(await run(PATROL_DEFAULTS.minFailures - 1, 600)).toBe(0)
    expect(await run(PATROL_DEFAULTS.minFailures, PATROL_DEFAULTS.minFailingMinutes - 1)).toBe(0)
    expect(await run(PATROL_DEFAULTS.minFailures, PATROL_DEFAULTS.minFailingMinutes)).toBe(1)
    // 阈值可以覆盖
    expect(await run(2, 10, { ...PATROL_DEFAULTS, minFailures: 2, minFailingMinutes: 5 })).toBe(1)
  })

  it("采集器停摆：所有源的最近尝试都很久以前，即使失败数是 0 也要报", async () => {
    const health = await healthFrom(async (store) => {
      await store.recordSuccess("good", NOW - 3 * 60 * MIN, 10)
    })
    const report = buildPatrolReport(health, { good: sources.good }, NOW)
    expect(report.failing).toEqual([])
    expect(report.collector).toMatchObject({ stalled: true, minutesSinceLastAttempt: 180 })
    expect(report.unhealthy).toBe(true)
  })

  it("库里一次尝试都没有：不算停摆，全部源 pending；全健康时 unhealthy 为 false", async () => {
    const empty = buildPatrolReport([], { good: sources.good, fresh: sources.fresh }, NOW)
    expect(empty).toMatchObject({ pending: ["good", "fresh"], unhealthy: false })
    expect(empty.collector).toMatchObject({ lastAttemptAt: null, stalled: false })

    const health = await healthFrom(async (store) => {
      await store.recordSuccess("good", NOW - MIN, 10)
    })
    expect(buildPatrolReport(health, { good: sources.good }, NOW).unhealthy).toBe(false)
  })
})

describe("issue 文本", () => {
  it("标题以 `[信源巡检] <id> ` 开头，正文含错误与阈值，错误里的反引号不会截断代码块", () => {
    const f = { sourceId: "ths", name: "同花顺", title: "快讯", intervalMinutes: 2, consecutiveFailures: 31, lastSuccessAt: NOW - 90 * MIN, minutesSinceLastSuccess: 90, lastError: "bad `json`", lastErrorAt: NOW }
    expect(issueTitle(f)).toBe("[信源巡检] ths 同花顺·快讯 连续失败")
    const body = issueBody(f, { generatedAtIso: "2026-11-21T15:00:00.000Z", thresholds: PATROL_DEFAULTS })
    expect(body).toContain("连续失败：31 次")
    expect(body).toContain("90 分钟前")
    expect(body).toContain("bad 'json'")
    expect(body).toContain(`>= ${PATROL_DEFAULTS.minFailures} 次`)
  })
})

describe("openIssues（假的 gh）", () => {
  async function failingReport() {
    const health = await healthFrom(async (store) => {
      await store.recordSuccess("down", NOW - 180 * MIN, 10)
      await failTimes(store, "down", 90, NOW - 178 * MIN)
      await store.recordSuccess("good", NOW - MIN, 10)
    })
    return buildPatrolReport(health, { good: sources.good, down: sources.down }, NOW)
  }
  function fakeGh(opts: { open?: { number: number, title: string, state?: "open" | "closed", closed_at?: string }[], labelExists?: boolean } = {}) {
    const calls: string[][] = []
    const runGh: RunGh = async (args) => {
      calls.push(args)
      if (args[1].includes("/labels/")) {
        if (opts.labelExists === false) throw new Error("gh: Not Found (HTTP 404)")
        return ""
      }
      if (args.includes("--paginate")) return (opts.open ?? []).map(i => JSON.stringify({ state: "open", ...i, html_url: `https://github.com/XartLab/KATANAview/issues/${i.number}` })).join("\n")
      return JSON.stringify({ number: 3001, html_url: "https://github.com/XartLab/KATANAview/issues/3001" })
    }
    return {
      runGh,
      calls,
      creates: () => calls.filter(c => c[1] === "repos/XartLab/KATANAview/issues" && c.includes("-f")),
      reopens: () => calls.filter(c => c.includes("PATCH")),
      comments: () => calls.filter(c => c[1].endsWith("/comments")),
    }
  }
  const base = { repo: "XartLab/KATANAview", label: "area:news" }

  it("没有同名未关闭的 issue：创建，带标签", async () => {
    const gh = fakeGh()
    const { actions } = await openIssues(await failingReport(), { ...base, dryRun: false, runGh: gh.runGh })
    expect(actions).toEqual([{ sourceId: "down", title: "[信源巡检] down 挂了的源·快讯 连续失败", action: "created", number: 3001, url: "https://github.com/XartLab/KATANAview/issues/3001", labeled: true }])
    const [create] = gh.creates()
    expect(create).toContain("labels[]=area:news")
    expect(create.find(a => a.startsWith("title="))).toBe("title=[信源巡检] down 挂了的源·快讯 连续失败")
  })

  it("已有同一个源的未关闭 issue：不重复创建（标题后缀不同也算）；别的源的 issue 不算", async () => {
    const same = fakeGh({ open: [{ number: 12, title: `${ISSUE_TITLE_PREFIX} down 挂了的源 连续失败（旧标题）` }] })
    const r1 = await openIssues(await failingReport(), { ...base, dryRun: false, runGh: same.runGh })
    expect(r1.actions.map(a => [a.action, a.number])).toEqual([["exists", 12]])
    expect(same.creates()).toEqual([])

    // `downstream` 以 `down` 开头，但不是同一个源：前缀里 id 后面带空格，不会误判
    const other = fakeGh({ open: [{ number: 13, title: `${ISSUE_TITLE_PREFIX} downstream 别的源 连续失败` }] })
    const r2 = await openIssues(await failingReport(), { ...base, dryRun: false, runGh: other.runGh })
    expect(r2.actions.map(a => a.action)).toEqual(["created"])
  })

  it("只有已关闭的同源 issue：重开最近关闭的那张并追加评论（失败次数、错误、时间），不新开", async () => {
    const gh = fakeGh({ open: [
      { number: 7, title: `${ISSUE_TITLE_PREFIX} down 挂了的源 连续失败`, state: "closed", closed_at: "2026-11-01T00:00:00Z" },
      { number: 9, title: `${ISSUE_TITLE_PREFIX} down 挂了的源 连续失败`, state: "closed", closed_at: "2026-11-15T00:00:00Z" },
      { number: 8, title: `${ISSUE_TITLE_PREFIX} downstream 别的源 连续失败`, state: "closed", closed_at: "2026-11-20T00:00:00Z" },
    ] })
    const { actions } = await openIssues(await failingReport(), { ...base, dryRun: false, runGh: gh.runGh })
    expect(actions.map(a => [a.action, a.number])).toEqual([["reopened", 9]])
    expect(gh.creates()).toEqual([])
    expect(gh.reopens()).toEqual([["api", "-X", "PATCH", "repos/XartLab/KATANAview/issues/9", "-f", "state=open"]])
    const [comment] = gh.comments()
    expect(comment[1]).toBe("repos/XartLab/KATANAview/issues/9/comments")
    const body = comment.find(a => a.startsWith("body="))!
    expect(body).toContain("本次连续失败：90 次")
    expect(body).toContain("503")
    expect(body).toContain("2026-11-21T15:00:00.000Z")
  })

  it("同一个源既有未关闭的又有已关闭的：只认未关闭的，不重开", async () => {
    const gh = fakeGh({ open: [
      { number: 5, title: `${ISSUE_TITLE_PREFIX} down 挂了的源 连续失败`, state: "closed", closed_at: "2026-11-01T00:00:00Z" },
      { number: 6, title: `${ISSUE_TITLE_PREFIX} down 挂了的源 连续失败` },
    ] })
    const { actions } = await openIssues(await failingReport(), { ...base, dryRun: false, runGh: gh.runGh })
    expect(actions.map(a => [a.action, a.number])).toEqual([["exists", 6]])
    expect(gh.reopens()).toEqual([])
    expect(gh.comments()).toEqual([])
  })

  it("--dry-run 遇到已关闭的同源 issue：只说会重开，不改任何东西", async () => {
    const gh = fakeGh({ open: [{ number: 9, title: `${ISSUE_TITLE_PREFIX} down 挂了的源 连续失败`, state: "closed", closed_at: "2026-11-15T00:00:00Z" }] })
    const { actions } = await openIssues(await failingReport(), { ...base, dryRun: true, runGh: gh.runGh })
    expect(actions.map(a => [a.action, a.number])).toEqual([["would-reopen", 9]])
    expect(gh.reopens()).toEqual([])
    expect(gh.comments()).toEqual([])
  })

  it("标签不存在：照样创建但不加标签，并报告 labelMissing", async () => {
    const gh = fakeGh({ labelExists: false })
    const { actions, labelMissing } = await openIssues(await failingReport(), { ...base, dryRun: false, runGh: gh.runGh })
    expect(labelMissing).toBe(true)
    expect(actions[0]).toMatchObject({ action: "created", labeled: false })
    expect(gh.creates()[0].some(a => a.startsWith("labels[]"))).toBe(false)
  })

  it("--dry-run：查重但什么都不创建", async () => {
    const gh = fakeGh()
    const { actions } = await openIssues(await failingReport(), { ...base, dryRun: true, runGh: gh.runGh })
    expect(actions.map(a => a.action)).toEqual(["would-create"])
    expect(gh.creates()).toEqual([])
  })

  it("没有要报的源：一次 gh 都不调", async () => {
    const gh = fakeGh()
    const healthy = buildPatrolReport([], {}, NOW)
    expect(await openIssues(healthy, { ...base, dryRun: false, runGh: gh.runGh })).toEqual({ actions: [], labelMissing: false })
    expect(gh.calls).toEqual([])
  })
})
