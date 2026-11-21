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

describe("大面积故障判定（massFailure）", () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { name: `源${i}`, interval: 2 * MIN }])) as Record<string, PatrolSourceMeta>
  /** 前 failing 个源挂了（3 小时没成功、连挂 90 次），其余正常 */
  async function reportWith(total: number, failing: number) {
    const health = await healthFrom(async (store) => {
      for (let i = 0; i < total; i++) {
        if (i < failing) {
          await store.recordSuccess(`s${i}`, NOW - 180 * MIN, 1)
          await failTimes(store, `s${i}`, 90, NOW - 178 * MIN, "fetch failed")
        } else {
          await store.recordSuccess(`s${i}`, NOW - MIN, 1)
        }
      }
    })
    return buildPatrolReport(health, many(total), NOW)
  }

  it("坏的源数 >= 已被尝试过的源的一半，且至少 3 个：算大面积故障", async () => {
    expect((await reportWith(6, 3)).massFailure).toBe(true)
    expect((await reportWith(6, 6)).massFailure).toBe(true)
    expect((await reportWith(6, 2)).massFailure).toBe(false)
    // 总数很少时一半只有 1–2 个：不到最少 3 个就不合并
    expect((await reportWith(4, 2)).massFailure).toBe(false)
    expect((await reportWith(2, 2)).massFailure).toBe(false)
    expect((await reportWith(5, 3)).massFailure).toBe(true)
    expect((await reportWith(5, 2)).massFailure).toBe(false)
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
  function fakeGh(opts: { open?: { number: number, title: string, state?: "open" | "closed", closed_at?: string, labels?: string[] }[], labelExists?: boolean, mutedLabelExists?: boolean, labelError?: string } = {}) {
    const calls: string[][] = []
    const runGh: RunGh = async (args) => {
      calls.push(args)
      if (args[1].includes("/labels/")) {
        const muted = args[1].includes("muted")
        if (opts.labelError) throw new Error(opts.labelError)
        if (muted ? opts.mutedLabelExists === false : opts.labelExists === false) throw new Error("gh: Not Found (HTTP 404)")
        return ""
      }
      if (args.includes("--paginate")) return (opts.open ?? []).map(i => JSON.stringify({ state: "open", labels: [], ...i, html_url: `https://github.com/XartLab/KATANAview/issues/${i.number}` })).join("\n")
      return JSON.stringify({ number: 3001, html_url: "https://github.com/XartLab/KATANAview/issues/3001" })
    }
    return {
      runGh,
      calls,
      creates: () => calls.filter(c => c[1] === "repos/XartLab/KATANAview/issues" && c.includes("-f")),
      listings: () => calls.filter(c => c.includes("--paginate")).map(c => c[2]),
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

  it("已关闭的同源 issue 关闭之后这个源没成功过（还在坏、人是没修好就关的）：不重开、不评论、不新开，标 closed-still-failing", async () => {
    // failingReport 里 down 的最近成功是 NOW-180 分钟；这张票在它之后（NOW-60 分钟）才关
    const gh = fakeGh({ open: [{ number: 9, title: `${ISSUE_TITLE_PREFIX} down 挂了的源 连续失败`, state: "closed", closed_at: new Date(NOW - 60 * MIN).toISOString() }] })
    const { actions } = await openIssues(await failingReport(), { ...base, dryRun: false, runGh: gh.runGh })
    expect(actions.map(a => [a.action, a.number])).toEqual([["closed-still-failing", 9]])
    expect(gh.reopens()).toEqual([])
    expect(gh.comments()).toEqual([])
    expect(gh.creates()).toEqual([])
  })

  it("带 news:muted 标签的已关闭 issue 永不重开，哪怕关了之后又成功过", async () => {
    const gh = fakeGh({ open: [{ number: 9, title: `${ISSUE_TITLE_PREFIX} down 挂了的源 连续失败`, state: "closed", closed_at: "2026-11-15T00:00:00Z", labels: ["area:news", "news:muted"] }] })
    const { actions } = await openIssues(await failingReport(), { ...base, dryRun: false, runGh: gh.runGh })
    expect(actions.map(a => [a.action, a.number])).toEqual([["muted", 9]])
    expect(gh.reopens()).toEqual([])
    expect(gh.comments()).toEqual([])
    expect(gh.creates()).toEqual([])
  })

  it("news:muted 标签在仓库里不存在：不影响重开，并在结果里写明静音标签缺失", async () => {
    const gh = fakeGh({ mutedLabelExists: false, open: [{ number: 9, title: `${ISSUE_TITLE_PREFIX} down 挂了的源 连续失败`, state: "closed", closed_at: "2026-11-15T00:00:00Z" }] })
    const res = await openIssues(await failingReport(), { ...base, dryRun: false, runGh: gh.runGh })
    expect(res.actions.map(a => a.action)).toEqual(["reopened"])
    expect(res.mutedLabelMissing).toBe(true)
  })

  it("标签存在时，查 issue 只查带这个标签的（避免随仓库增长越翻越慢）；标签不存在时退回全量", async () => {
    const withLabel = fakeGh()
    await openIssues(await failingReport(), { ...base, dryRun: true, runGh: withLabel.runGh })
    expect(withLabel.listings()).toEqual(["repos/XartLab/KATANAview/issues?state=all&per_page=100&labels=area%3Anews"])
    const noLabel = fakeGh({ labelExists: false })
    await openIssues(await failingReport(), { ...base, dryRun: true, runGh: noLabel.runGh })
    expect(noLabel.listings()).toEqual(["repos/XartLab/KATANAview/issues?state=all&per_page=100"])
  })

  it("标签检查只把 404 当「不存在」；403、网络错误等直接抛出，不创建任何 issue", async () => {
    for (const labelError of ["gh: Forbidden (HTTP 403)", "dial tcp: lookup api.github.com: no such host"]) {
      const gh = fakeGh({ labelError })
      await expect(openIssues(await failingReport(), { ...base, dryRun: false, runGh: gh.runGh })).rejects.toThrow(labelError)
      expect(gh.creates()).toEqual([])
    }
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

  describe("大面积故障合并成一张汇总 issue", () => {
    const MASS_PREFIX = `${ISSUE_TITLE_PREFIX} 多数信源同时失败 `
    async function massReport() {
      const meta = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s${i}`, { name: `源${i}`, interval: 2 * MIN }])) as Record<string, PatrolSourceMeta>
      const health = await healthFrom(async (store) => {
        for (let i = 0; i < 6; i++) {
          await store.recordSuccess(`s${i}`, NOW - (200 - i) * MIN, 1)
          await failTimes(store, `s${i}`, 90, NOW - 150 * MIN, "fetch failed")
        }
        await store.recordSuccess("s5", NOW - 1 * MIN, 1)
      })
      const report = buildPatrolReport(health, meta, NOW)
      expect(report.massFailure).toBe(true)
      expect(report.failing).toHaveLength(5)
      return report
    }

    it("只创建一张汇总 issue，列出所有坏的源，不逐源创建", async () => {
      const gh = fakeGh()
      const { actions } = await openIssues(await massReport(), { ...base, dryRun: false, runGh: gh.runGh })
      expect(actions.map(a => [a.action, a.sourceId])).toEqual([["created", "mass-failure"]])
      expect(gh.creates()).toHaveLength(1)
      const [create] = gh.creates()
      expect(create.find(a => a.startsWith("title="))!.startsWith(`title=${MASS_PREFIX}`)).toBe(true)
      const body = create.find(a => a.startsWith("body="))!
      for (const id of ["s0", "s1", "s2", "s3", "s4"]) expect(body).toContain(`\`${id}\``)
      expect(body).toContain("本机断网")
    })

    it("已有未关闭的汇总 issue：不重复创建；dry-run 不创建", async () => {
      const gh = fakeGh({ open: [{ number: 31, title: `${MASS_PREFIX}疑似本机断网或采集器故障` }] })
      const r = await openIssues(await massReport(), { ...base, dryRun: false, runGh: gh.runGh })
      expect(r.actions.map(a => [a.action, a.number])).toEqual([["exists", 31]])
      const dry = fakeGh()
      const r2 = await openIssues(await massReport(), { ...base, dryRun: true, runGh: dry.runGh })
      expect(r2.actions.map(a => a.action)).toEqual(["would-create"])
      expect(dry.creates()).toEqual([])
    })

    it("已关闭的汇总 issue：关了之后有源成功过（现在又大面积坏）才重开，否则不动", async () => {
      // 坏的源里最近成功是 NOW-196 分钟（s4）
      const stillBad = fakeGh({ open: [{ number: 31, title: `${MASS_PREFIX}x`, state: "closed", closed_at: new Date(NOW - 60 * MIN).toISOString() }] })
      const r1 = await openIssues(await massReport(), { ...base, dryRun: false, runGh: stillBad.runGh })
      expect(r1.actions.map(a => a.action)).toEqual(["closed-still-failing"])
      const recovered = fakeGh({ open: [{ number: 31, title: `${MASS_PREFIX}x`, state: "closed", closed_at: new Date(NOW - 400 * MIN).toISOString() }] })
      const r2 = await openIssues(await massReport(), { ...base, dryRun: false, runGh: recovered.runGh })
      expect(r2.actions.map(a => a.action)).toEqual(["reopened"])
      expect(recovered.creates()).toEqual([])
    })

    it("大面积故障时再停摆：汇总与停摆各一张", async () => {
      const report = await massReport()
      const gh = fakeGh()
      const { actions } = await openIssues({ ...report, collector: { ...report.collector, stalled: true, minutesSinceLastAttempt: 90 } }, { ...base, dryRun: false, runGh: gh.runGh })
      expect(actions.map(a => a.sourceId).sort()).toEqual(["collector", "mass-failure"])
    })
  })

  describe("采集器停摆也走同一套 issue 流程", () => {
    const STALLED_PREFIX = `${ISSUE_TITLE_PREFIX} 采集器停摆 `
    /** 停摆：最近一次尝试在 3 小时前；源本身没有失败（source_health 冻结了） */
    async function stalledReport() {
      const health = await healthFrom(async (store) => {
        await store.recordSuccess("good", NOW - 180 * MIN, 10)
      })
      const report = buildPatrolReport(health, { good: sources.good }, NOW)
      expect(report.failing).toEqual([])
      expect(report.collector.stalled).toBe(true)
      return report
    }

    it("停摆且没有失败的源：创建一张固定前缀的 issue，正文写最近一次尝试时间与阈值", async () => {
      const gh = fakeGh()
      const { actions } = await openIssues(await stalledReport(), { ...base, dryRun: false, runGh: gh.runGh })
      expect(actions.map(a => [a.action, a.sourceId])).toEqual([["created", "collector"]])
      const [create] = gh.creates()
      const title = create.find(a => a.startsWith("title="))!.slice("title=".length)
      expect(title.startsWith(STALLED_PREFIX)).toBe(true)
      const body = create.find(a => a.startsWith("body="))!
      expect(body).toContain(new Date(NOW - 180 * MIN).toISOString())
      expect(body).toContain("180 分钟前")
      expect(body).toContain(`>= ${PATROL_DEFAULTS.collectorStalledMinutes} 分钟`)
    })

    it("--dry-run：只说会创建，不创建", async () => {
      const gh = fakeGh()
      const { actions } = await openIssues(await stalledReport(), { ...base, dryRun: true, runGh: gh.runGh })
      expect(actions.map(a => a.action)).toEqual(["would-create"])
      expect(gh.creates()).toEqual([])
    })

    it("已有未关闭的停摆 issue：不重复创建", async () => {
      const gh = fakeGh({ open: [{ number: 21, title: `${STALLED_PREFIX}所有源都没有新的采集尝试` }] })
      const { actions } = await openIssues(await stalledReport(), { ...base, dryRun: false, runGh: gh.runGh })
      expect(actions.map(a => [a.action, a.number])).toEqual([["exists", 21]])
      expect(gh.creates()).toEqual([])
    })

    it("已关闭的停摆 issue：关了之后采集器又跑过（最近尝试晚于 closed_at）才重开；还停着就不重开", async () => {
      const ranAfterClose = fakeGh({ open: [{ number: 21, title: `${STALLED_PREFIX}x`, state: "closed", closed_at: new Date(NOW - 5 * 24 * 60 * MIN).toISOString() }] })
      const r1 = await openIssues(await stalledReport(), { ...base, dryRun: false, runGh: ranAfterClose.runGh })
      expect(r1.actions.map(a => [a.action, a.number])).toEqual([["reopened", 21]])
      expect(ranAfterClose.comments()).toHaveLength(1)

      const stillStalled = fakeGh({ open: [{ number: 21, title: `${STALLED_PREFIX}x`, state: "closed", closed_at: new Date(NOW - 60 * MIN).toISOString() }] })
      const r2 = await openIssues(await stalledReport(), { ...base, dryRun: false, runGh: stillStalled.runGh })
      expect(r2.actions.map(a => a.action)).toEqual(["closed-still-failing"])
      expect(stillStalled.reopens()).toEqual([])
    })

    it("停摆的同时有失败的源：两张 issue 都处理", async () => {
      const report = await failingReport()
      const stalled = { ...report, collector: { ...report.collector, stalled: true, minutesSinceLastAttempt: 90 }, unhealthy: true }
      const gh = fakeGh()
      const { actions } = await openIssues(stalled, { ...base, dryRun: false, runGh: gh.runGh })
      expect(actions.map(a => [a.sourceId, a.action]).sort()).toEqual([["collector", "created"], ["down", "created"]])
    })
  })

  it("没有要报的源：一次 gh 都不调", async () => {
    const gh = fakeGh()
    const healthy = buildPatrolReport([], {}, NOW)
    expect(await openIssues(healthy, { ...base, dryRun: false, runGh: gh.runGh })).toEqual({ actions: [], labelMissing: false, mutedLabelMissing: false })
    expect(gh.calls).toEqual([])
  })
})
