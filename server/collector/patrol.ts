import type { HealthRecord } from "./store"

/**
 * 每日巡检（#2187）：读观测库的 source_health，找出连续失败的源，可选地到 XartLab/KATANAview 开 issue。
 * 纯逻辑放这里（可测），命令行入口在 scripts/sources-patrol.ts。
 */

/**
 * 阈值，全部「待定」：现在没有积累下来的健康数据可以拟合，下面是保守的起点，
 * 本机连续跑一周后看 `pnpm sources:patrol --format text` 里 watching 一栏的抖动情况再调。
 */
export const PATROL_DEFAULTS = {
  /**
   * 连续失败至少几次才算坏。待定。
   * 取 5：采集器的 myFetch 单次请求已经自带 3 次重试（server/utils/fetch.ts），一次「失败」是 4 次请求都没成；
   * 连续 5 个周期都这样，基本不是网络抖动。
   */
  minFailures: 5,
  /**
   * 且距最近一次成功至少多少分钟。待定。
   * 取 60：等于最慢一档的 interval（shared/pre-sources.ts 的 Time.Slow），
   * 2 分钟一档的快讯源连挂 5 次才 10 分钟，那是本机断网一会儿的量级，不该开 issue；
   * 要求 60 分钟没成功，才排除掉这类短暂中断。从没成功过的源不受这条限制（它从一开始就是坏的）。
   */
  minFailingMinutes: 60,
  /**
   * 整个采集器多少分钟没有任何一次尝试就算停摆。待定。
   * 取 15：最快一档 2 分钟、tick 每分钟一次，采集器活着时必然每几分钟就有源被尝试；
   * 停摆时 source_health 不再变化，连续失败数也不再涨，只看失败数会漏报，所以单独查这一条。
   */
  collectorStalledMinutes: 15,
} as const

export interface PatrolThresholds {
  minFailures: number
  minFailingMinutes: number
  collectorStalledMinutes: number
}

export interface PatrolSourceMeta {
  name: string
  title?: string
  interval: number
  redirect?: string
}

export interface FailingSource {
  sourceId: string
  name: string
  title: string | null
  intervalMinutes: number
  consecutiveFailures: number
  lastSuccessAt: number | null
  minutesSinceLastSuccess: number | null
  lastError: string | null
  lastErrorAt: number | null
}

export interface PatrolReport {
  generatedAt: number
  generatedAtIso: string
  thresholds: PatrolThresholds
  collector: {
    /** 所有源里最近一次尝试的时间；一次都没有为 null */
    lastAttemptAt: number | null
    minutesSinceLastAttempt: number | null
    stalled: boolean
  }
  /** 达到阈值的：要报的 */
  failing: FailingSource[]
  /** 有失败但没到阈值的：先看着 */
  watching: FailingSource[]
  /** 在源清单里、但从没被尝试过的（刚加的源，或采集器没跑过） */
  pending: string[]
  okCount: number
  /** 是否有要报的（failing 非空或采集器停摆）；命令行据此决定退出码 */
  unhealthy: boolean
}

const MINUTE = 60_000

export function buildPatrolReport(
  health: HealthRecord[],
  sources: Record<string, PatrolSourceMeta>,
  now: number,
  thresholds: PatrolThresholds = PATROL_DEFAULTS,
): PatrolReport {
  const rows = new Map(health.map(h => [h.sourceId, h]))
  const failing: FailingSource[] = []
  const watching: FailingSource[] = []
  const pending: string[] = []
  let okCount = 0
  let newestAttempt: number | null = null

  for (const h of health) {
    if (h.lastAttemptAt !== null && (newestAttempt === null || h.lastAttemptAt > newestAttempt)) newestAttempt = h.lastAttemptAt
  }

  for (const [sourceId, meta] of Object.entries(sources)) {
    if (meta.redirect) continue
    const h = rows.get(sourceId)
    if (!h || h.lastAttemptAt === null) {
      pending.push(sourceId)
      continue
    }
    if (h.consecutiveFailures === 0) {
      okCount++
      continue
    }
    const minutesSinceLastSuccess = h.lastSuccessAt === null ? null : Math.floor((now - h.lastSuccessAt) / MINUTE)
    const entry: FailingSource = {
      sourceId,
      name: meta.name,
      title: meta.title ?? null,
      intervalMinutes: Math.round(meta.interval / MINUTE),
      consecutiveFailures: h.consecutiveFailures,
      lastSuccessAt: h.lastSuccessAt,
      minutesSinceLastSuccess,
      lastError: h.lastError,
      lastErrorAt: h.lastErrorAt,
    }
    const longEnough = minutesSinceLastSuccess === null || minutesSinceLastSuccess >= thresholds.minFailingMinutes
    ;(h.consecutiveFailures >= thresholds.minFailures && longEnough ? failing : watching).push(entry)
  }

  const minutesSinceLastAttempt = newestAttempt === null ? null : Math.floor((now - newestAttempt) / MINUTE)
  // 库里一次尝试都没有：采集器还没跑过，不算停摆（pending 里会列出全部源）
  const stalled = minutesSinceLastAttempt !== null && minutesSinceLastAttempt >= thresholds.collectorStalledMinutes
  failing.sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || a.sourceId.localeCompare(b.sourceId))
  return {
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    thresholds,
    collector: { lastAttemptAt: newestAttempt, minutesSinceLastAttempt, stalled },
    failing,
    watching,
    pending,
    okCount,
    unhealthy: failing.length > 0 || stalled,
  }
}

/** 标题以 `[信源巡检] <源 id> ` 开头，去重靠它，所以 id 后面必须有空格。 */
export const ISSUE_TITLE_PREFIX = "[信源巡检]"
export function issueTitle(f: Pick<FailingSource, "sourceId" | "name" | "title">) {
  return `${ISSUE_TITLE_PREFIX} ${f.sourceId} ${f.name}${f.title ? `·${f.title}` : ""} 连续失败`
}
export function issueTitlePrefix(sourceId: string) {
  return `${ISSUE_TITLE_PREFIX} ${sourceId} `
}

export function issueBody(f: FailingSource, report: Pick<PatrolReport, "generatedAtIso" | "thresholds">) {
  const time = (ms: number | null) => ms === null ? "从未成功" : new Date(ms).toISOString()
  return [
    `每日巡检（\`pnpm sources:patrol\`，${report.generatedAtIso}）发现信源 \`${f.sourceId}\`（${f.name}${f.title ? `·${f.title}` : ""}）一直在失败。`,
    "",
    `- 连续失败：${f.consecutiveFailures} 次（采集间隔 ${f.intervalMinutes} 分钟）`,
    `- 最近一次成功：${time(f.lastSuccessAt)}${f.minutesSinceLastSuccess === null ? "" : `（${f.minutesSinceLastSuccess} 分钟前）`}`,
    `- 最近一次失败：${time(f.lastErrorAt)}`,
    `- 最近的错误：\`${(f.lastError ?? "无").replace(/`/g, "'").slice(0, 300)}\``,
    "",
    `判定阈值（待定）：连续失败 >= ${report.thresholds.minFailures} 次，且距最近成功 >= ${report.thresholds.minFailingMinutes} 分钟。`,
    "",
    "怎么查：在 newsnow fork 里 `pnpm collector:check` 看这个源的观测；对着错误信息看是站点改了结构、被拒绝还是网络问题，再改 `server/sources/` 里的适配器。",
    "修好后本巡检不会自动关这张 issue，请手动关。",
    "",
    "_由 `scripts/sources-patrol.ts` 自动创建；同一个源有未关闭的同名 issue 时不会重复创建。_",
  ].join("\n")
}

/** 跑 `gh` 子命令并返回 stdout；失败时抛错。命令行用 execFile 实现，测试里换成假的。 */
export type RunGh = (args: string[]) => Promise<string>

export interface IssueAction {
  sourceId: string
  title: string
  action: "created" | "exists" | "reopened" | "would-create" | "would-reopen"
  number?: number
  url?: string
  labeled: boolean
}

export interface OpenIssuesOptions {
  repo: string
  label: string
  dryRun: boolean
  runGh: RunGh
}

interface IssueRef {
  number: number
  title: string
  html_url?: string
  state?: string
  closed_at?: string | null
}

/** 重开时追加的评论：本次失败次数、最近错误、时间。 */
export function reopenComment(f: FailingSource, report: Pick<PatrolReport, "generatedAtIso" | "thresholds">) {
  const time = (ms: number | null) => ms === null ? "从未成功" : new Date(ms).toISOString()
  return [
    `每日巡检（${report.generatedAtIso}）发现 \`${f.sourceId}\` 再次连续失败，重新打开。`,
    "",
    `- 本次连续失败：${f.consecutiveFailures} 次（采集间隔 ${f.intervalMinutes} 分钟）`,
    `- 最近一次成功：${time(f.lastSuccessAt)}${f.minutesSinceLastSuccess === null ? "" : `（${f.minutesSinceLastSuccess} 分钟前）`}`,
    `- 最近一次失败：${time(f.lastErrorAt)}`,
    `- 最近的错误：\`${(f.lastError ?? "无").replace(/`/g, "'").slice(0, 300)}\``,
    "",
    `判定阈值（待定）：连续失败 >= ${report.thresholds.minFailures} 次，且距最近成功 >= ${report.thresholds.minFailingMinutes} 分钟。`,
  ].join("\n")
}

/**
 * 给 failing 里的每个源处理一张 issue：
 * - 已有未关闭的同源 issue：不动；
 * - 没有未关闭的、但有已关闭的同源 issue：重新打开最近关闭的那张并追加一条评论，不新开；
 * - 都没有：新建。
 * 同源 = 标题以 `[信源巡检] <源 id> ` 开头。只走 `gh api` 的 REST 路径（不用 `gh issue ...`，它走 GraphQL，在受限环境里被拒）。
 * 标签不存在就不加（GitHub 对不存在的标签会自动创建，那会悄悄建出一个没人规划的标签），在返回里标 labeled: false。
 */
export async function openIssues(report: PatrolReport, opts: OpenIssuesOptions): Promise<{ actions: IssueAction[], labelMissing: boolean }> {
  const { repo, label, dryRun, runGh } = opts
  if (!report.failing.length) return { actions: [], labelMissing: false }

  // 开着的与关了的都要看（REST 的 /issues 也会返回 PR，用 pull_request 字段滤掉）
  const raw = await runGh(["api", "--paginate", `repos/${repo}/issues?state=all&per_page=100`, "--jq", ".[] | select(.pull_request | not) | {number, title, html_url, state, closed_at}"])
  const all: IssueRef[] = raw.split("\n").map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l))

  let labelMissing = false
  try {
    await runGh(["api", `repos/${repo}/labels/${encodeURIComponent(label)}`, "--silent"])
  } catch {
    labelMissing = true
  }

  const actions: IssueAction[] = []
  for (const f of report.failing) {
    const title = issueTitle(f)
    const same = all.filter(i => i.title.startsWith(issueTitlePrefix(f.sourceId)))
    const existing = same.find(i => i.state === "open")
    if (existing) {
      actions.push({ sourceId: f.sourceId, title: existing.title, action: "exists", number: existing.number, url: existing.html_url, labeled: false })
      continue
    }
    // 最近关闭的：closed_at 最晚的；时间相同取编号大的
    const closed = same.filter(i => i.state === "closed")
      .sort((a, b) => Date.parse(b.closed_at ?? "") - Date.parse(a.closed_at ?? "") || b.number - a.number)[0]
    if (closed) {
      if (dryRun) {
        actions.push({ sourceId: f.sourceId, title: closed.title, action: "would-reopen", number: closed.number, url: closed.html_url, labeled: false })
        continue
      }
      await runGh(["api", "-X", "PATCH", `repos/${repo}/issues/${closed.number}`, "-f", "state=open"])
      await runGh(["api", `repos/${repo}/issues/${closed.number}/comments`, "-f", `body=${reopenComment(f, report)}`])
      actions.push({ sourceId: f.sourceId, title: closed.title, action: "reopened", number: closed.number, url: closed.html_url, labeled: false })
      continue
    }
    if (dryRun) {
      actions.push({ sourceId: f.sourceId, title, action: "would-create", labeled: !labelMissing })
      continue
    }
    const args = ["api", `repos/${repo}/issues`, "-f", `title=${title}`, "-f", `body=${issueBody(f, report)}`]
    if (!labelMissing) args.push("-f", `labels[]=${label}`)
    const created: IssueRef = JSON.parse(await runGh(args))
    actions.push({ sourceId: f.sourceId, title, action: "created", number: created.number, url: created.html_url, labeled: !labelMissing })
  }
  return { actions, labelMissing }
}
