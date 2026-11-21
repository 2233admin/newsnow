import { isUserSourceId } from "../registry/spec"
import type { HealthRecord } from "./store"

/**
 * 每日巡检（#2187）：读观测库的 source_health，找出连续失败的源，可选地到 XartLab/KATANAview 开 issue。
 * 纯逻辑放这里（可测），命令行入口在 scripts/sources-patrol.ts。
 * 覆盖内置源与已启用的用户源（`user:*`，含预置订阅包启用的）：谁在被巡检由调用方传入的 sources 决定。
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
  /**
   * 坏的源数占「被尝试过的源」多大比例以上，就当大面积故障、合并成一张汇总 issue。待定。
   * 取 0.5：照独立审阅的建议（一半以上同时坏，更像本机断网或采集器故障，而不是几十个站点各自出事）。
   */
  massFailureRatio: 0.5,
  /**
   * 且坏的源至少几个。待定。
   * 取 3：只部署了两三个源时「一半」只有 1–2 个，那是正常的单源故障，不该合并。
   */
  massFailureMinSources: 3,
} as const

export interface PatrolThresholds {
  minFailures: number
  minFailingMinutes: number
  collectorStalledMinutes: number
  massFailureRatio: number
  massFailureMinSources: number
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
  /** failing 的数量到了大面积故障的线：开 issue 时合并成一张汇总，不逐源开 */
  massFailure: boolean
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
    massFailure: failing.length >= Math.max(thresholds.massFailureMinSources, Math.ceil((okCount + failing.length + watching.length) * thresholds.massFailureRatio)),
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
    isUserSourceId(f.sourceId)
      ? "怎么查：这是用户订阅源（含预置订阅包启用的），没有适配器代码可改。`pnpm collector:check` 看这个源的观测，对着错误信息看是地址变了、站点拒绝（反爬、限流）还是网络问题；确认失效就在设置里改地址或停用（停用后巡检不再报它）。"
      : "怎么查：在 newsnow fork 里 `pnpm collector:check` 看这个源的观测；对着错误信息看是站点改了结构、被拒绝还是网络问题，再改 `server/sources/` 里的适配器。",
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
  action: "created" | "exists" | "reopened" | "would-create" | "would-reopen" | "closed-still-failing" | "muted"
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
  labels?: string[]
}

/** 带这个标签的已关闭 issue 永不重开（人明确说「不再提醒」）。仓库里没有这个标签就没有票能带它，等于不启用。 */
export const MUTED_LABEL = "news:muted"

/** 标签是否存在：只有 404 算不存在，别的错误原样抛出。 */
async function labelExists(runGh: RunGh, repo: string, label: string) {
  try {
    await runGh(["api", `repos/${repo}/labels/${encodeURIComponent(label)}`, "--silent"])
    return true
  } catch (e) {
    if (/\b404\b|Not Found/i.test(e instanceof Error ? e.message : String(e))) return false
    throw e
  }
}

/** 一张要维护的 issue：一个源，或「采集器停摆」。 */
interface IssueTarget {
  /** IssueAction.sourceId 里写的名字 */
  key: string
  /** 同类 issue 的标题前缀（带空格），去重与重开靠它 */
  prefix: string
  title: string
  body: string
  comment: string
  /**
   * 「修好过」的证据时间：该 issue 关闭之后这个时间还在更新，才说明关掉之后好过又坏了。
   * 源取最近成功时间；采集器停摆取最近一次尝试时间；没有证据为 null（永不重开）。
   */
  recoveredAt: number | null
}

const COLLECTOR_STALLED_PREFIX = `${ISSUE_TITLE_PREFIX} 采集器停摆 `
const MASS_FAILURE_PREFIX = `${ISSUE_TITLE_PREFIX} 多数信源同时失败 `

const isoOrNever = (ms: number | null) => ms === null ? "从未成功" : new Date(ms).toISOString()

function sourceTarget(f: FailingSource, report: Pick<PatrolReport, "generatedAtIso" | "thresholds">): IssueTarget {
  return {
    key: f.sourceId,
    prefix: issueTitlePrefix(f.sourceId),
    title: issueTitle(f),
    body: issueBody(f, report),
    comment: reopenComment(f, report),
    recoveredAt: f.lastSuccessAt,
  }
}

function stalledBody(report: PatrolReport, heading: string) {
  const { lastAttemptAt, minutesSinceLastAttempt } = report.collector
  return [
    heading,
    "",
    `- 最近一次采集尝试：${lastAttemptAt === null ? "从未" : new Date(lastAttemptAt).toISOString()}${minutesSinceLastAttempt === null ? "" : `（${minutesSinceLastAttempt} 分钟前）`}`,
    `- 判定阈值（待定）：所有源的最近一次尝试都在 >= ${report.thresholds.collectorStalledMinutes} 分钟前`,
    "",
    "采集器停摆时 `source_health` 不再变化，各源的连续失败数也不再增长，所以逐源的巡检报不出来，要靠这一条。",
    "先看本机的服务进程是否还活着、`COLLECT_ENABLED` 是否被关、日志里 `collect:tick` 是否还在输出。",
  ].join("\n")
}

function stalledTarget(report: PatrolReport): IssueTarget {
  return {
    key: "collector",
    prefix: COLLECTOR_STALLED_PREFIX,
    title: `${COLLECTOR_STALLED_PREFIX}所有源都没有新的采集尝试`,
    body: [
      stalledBody(report, `每日巡检（\`pnpm sources:patrol\`，${report.generatedAtIso}）发现采集器停摆。`),
      "",
      "修好后本巡检不会自动关这张 issue，请手动关。",
      "",
      "_由 `scripts/sources-patrol.ts` 自动创建；有未关闭的同类 issue 时不会重复创建。_",
    ].join("\n"),
    comment: stalledBody(report, `每日巡检（${report.generatedAtIso}）发现采集器再次停摆，重新打开。`),
    recoveredAt: report.collector.lastAttemptAt,
  }
}

function massFailureBody(report: PatrolReport, heading: string) {
  const lines = report.failing.map(f => `- \`${f.sourceId}\`（${f.name}）：连续失败 ${f.consecutiveFailures} 次，${f.minutesSinceLastSuccess === null ? "从未成功" : `${f.minutesSinceLastSuccess} 分钟没成功`}，错误 \`${(f.lastError ?? "无").replace(/`/g, "'").slice(0, 120)}\``)
  return [
    heading,
    "",
    `同时坏了 ${report.failing.length} 个源（占被尝试过的 ${report.okCount + report.failing.length + report.watching.length} 个源的一半以上），疑似本机断网或采集器故障，不是各站点各自出事，所以不逐源开 issue。`,
    "",
    ...lines,
    "",
    "先看本机网络与代理是否正常，再看采集器日志；网络恢复后各源会自己恢复，不需要逐个改适配器。",
  ].join("\n")
}

function massFailureTarget(report: PatrolReport): IssueTarget {
  const lastSuccesses = report.failing.map(f => f.lastSuccessAt).filter((t): t is number => t !== null)
  return {
    key: "mass-failure",
    prefix: MASS_FAILURE_PREFIX,
    title: `${MASS_FAILURE_PREFIX}疑似本机断网或采集器故障`,
    body: [
      massFailureBody(report, `每日巡检（\`pnpm sources:patrol\`，${report.generatedAtIso}）发现多数信源同时失败。`),
      "",
      "修好后本巡检不会自动关这张 issue，请手动关。",
      "",
      "_由 `scripts/sources-patrol.ts` 自动创建；有未关闭的同类 issue 时不会重复创建。_",
    ].join("\n"),
    comment: massFailureBody(report, `每日巡检（${report.generatedAtIso}）发现多数信源再次同时失败，重新打开。`),
    // 关了之后任何一个坏的源成功过，就说明好过又坏了
    recoveredAt: lastSuccesses.length ? Math.max(...lastSuccesses) : null,
  }
}

/** 重开时追加的评论：本次失败次数、最近错误、时间。 */
export function reopenComment(f: FailingSource, report: Pick<PatrolReport, "generatedAtIso" | "thresholds">) {
  return [
    `每日巡检（${report.generatedAtIso}）发现 \`${f.sourceId}\` 再次连续失败，重新打开。`,
    "",
    `- 本次连续失败：${f.consecutiveFailures} 次（采集间隔 ${f.intervalMinutes} 分钟）`,
    `- 最近一次成功：${isoOrNever(f.lastSuccessAt)}${f.minutesSinceLastSuccess === null ? "" : `（${f.minutesSinceLastSuccess} 分钟前）`}`,
    `- 最近一次失败：${isoOrNever(f.lastErrorAt)}`,
    `- 最近的错误：\`${(f.lastError ?? "无").replace(/`/g, "'").slice(0, 300)}\``,
    "",
    `判定阈值（待定）：连续失败 >= ${report.thresholds.minFailures} 次，且距最近成功 >= ${report.thresholds.minFailingMinutes} 分钟。`,
  ].join("\n")
}

/**
 * 给要报的每一项（坏掉的源、采集器停摆）处理一张 issue：
 * - 已有未关闭的同类 issue：不动；
 * - 没有未关闭的、但有已关闭的：关了之后「修好过」（见 IssueTarget.recoveredAt）才重开最近关闭的那张并追加评论；
 *   带 news:muted 标签的永不重开；没修好过的标 closed-still-failing，不重开也不新开；
 * - 都没有：新建。
 * 同类 = 标题以 `[信源巡检] <源 id> ` 或 `[信源巡检] 采集器停摆 ` 开头。只走 `gh api` 的 REST 路径（不用 `gh issue ...`，它走 GraphQL，在受限环境里被拒）。
 * 标签不存在就不加（GitHub 对不存在的标签会自动创建，那会悄悄建出一个没人规划的标签），在返回里标 labeled: false。
 */
export async function openIssues(report: PatrolReport, opts: OpenIssuesOptions): Promise<{ actions: IssueAction[], labelMissing: boolean, mutedLabelMissing: boolean }> {
  const { repo, label, dryRun, runGh } = opts
  // 大面积故障合并成一张汇总，不逐源开
  const targets: IssueTarget[] = report.massFailure ? [massFailureTarget(report)] : report.failing.map(f => sourceTarget(f, report))
  if (report.collector.stalled) targets.push(stalledTarget(report))
  if (!targets.length) return { actions: [], labelMissing: false, mutedLabelMissing: false }

  // 标签检查只把 404 当「不存在」；403、网络错误等直接抛出（退出码 2），不能因为一次抖动就创建一张没标签的 issue
  const labelMissing = !(await labelExists(runGh, repo, label))
  const mutedLabelMissing = !(await labelExists(runGh, repo, MUTED_LABEL))

  // 开着的与关了的都要看（REST 的 /issues 也会返回 PR，用 pull_request 字段滤掉）。
  // 标签存在时只查带它的：全量翻页对上千条 issue 的仓库要 30 秒（2026-11-21 审阅者实测），且随仓库增长线性变长；
  // 代价是标签建立之前就有的巡检 issue（没有标签）查不到，退回全量只在标签不存在时。
  const filter = labelMissing ? "" : `&labels=${encodeURIComponent(label)}`
  const raw = await runGh(["api", "--paginate", `repos/${repo}/issues?state=all&per_page=100${filter}`, "--jq", ".[] | select(.pull_request | not) | {number, title, html_url, state, closed_at, labels: [.labels[].name]}"])
  const all: IssueRef[] = raw.split("\n").map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l))

  const actions: IssueAction[] = []
  for (const t of targets) {
    const same = all.filter(i => i.title.startsWith(t.prefix))
    const existing = same.find(i => i.state === "open")
    if (existing) {
      actions.push({ sourceId: t.key, title: existing.title, action: "exists", number: existing.number, url: existing.html_url, labeled: false })
      continue
    }
    // 最近关闭的：closed_at 最晚的；时间相同取编号大的
    const closed = same.filter(i => i.state === "closed")
      .sort((a, b) => Date.parse(b.closed_at ?? "") - Date.parse(a.closed_at ?? "") || b.number - a.number)[0]
    if (closed) {
      // 人故意关掉的不重开：带静音标签的永不重开；其余的只在「关了之后好过、现在又坏」时重开，
      // 否则是没修好就关的（wontfix、暂时下线、等上游），重开只会每天吵一次
      if (closed.labels?.includes(MUTED_LABEL)) {
        actions.push({ sourceId: t.key, title: closed.title, action: "muted", number: closed.number, url: closed.html_url, labeled: false })
        continue
      }
      const closedAt = Date.parse(closed.closed_at ?? "")
      if (t.recoveredAt === null || !(t.recoveredAt > closedAt)) {
        actions.push({ sourceId: t.key, title: closed.title, action: "closed-still-failing", number: closed.number, url: closed.html_url, labeled: false })
        continue
      }
      if (dryRun) {
        actions.push({ sourceId: t.key, title: closed.title, action: "would-reopen", number: closed.number, url: closed.html_url, labeled: false })
        continue
      }
      await runGh(["api", "-X", "PATCH", `repos/${repo}/issues/${closed.number}`, "-f", "state=open"])
      await runGh(["api", `repos/${repo}/issues/${closed.number}/comments`, "-f", `body=${t.comment}`])
      actions.push({ sourceId: t.key, title: closed.title, action: "reopened", number: closed.number, url: closed.html_url, labeled: false })
      continue
    }
    if (dryRun) {
      actions.push({ sourceId: t.key, title: t.title, action: "would-create", labeled: !labelMissing })
      continue
    }
    const args = ["api", `repos/${repo}/issues`, "-f", `title=${t.title}`, "-f", `body=${t.body}`]
    if (!labelMissing) args.push("-f", `labels[]=${label}`)
    const created: IssueRef = JSON.parse(await runGh(args))
    actions.push({ sourceId: t.key, title: t.title, action: "created", number: created.number, url: created.html_url, labeled: !labelMissing })
  }
  return { actions, labelMissing, mutedLabelMissing }
}
