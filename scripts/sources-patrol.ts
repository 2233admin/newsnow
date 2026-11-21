/**
 * 每日巡检：读观测库的 source_health，列出连续失败的源（阈值与依据见 server/collector/patrol.ts），
 * 默认把机器可读的 JSON 报告打到 stdout，只读、不开 issue。
 *
 *   pnpm sources:patrol                          # JSON 报告
 *   pnpm sources:patrol --format text            # 给人看的表
 *   pnpm sources:patrol --open-issues            # 给每个坏掉的源在 XartLab/KATANAview 开 issue（已有未关闭的同源 issue 跳过；只有已关闭的、且关了之后这个源又成功过，才重开最近那张并追加评论；带 news:muted 标签的永不重开）
 *   pnpm sources:patrol --open-issues --dry-run  # 只查重、只打印会开 / 重开什么，不改任何东西
 *   选项：--db <路径>（默认 .data/db.sqlite3）、--repo <owner/repo>、--label <标签>（默认 area:news）、
 *        --min-failures <n>、--min-minutes <n>、--stalled-minutes <n>
 *
 * 退出码：0 = 健康；1 = 有要报的源或采集器停摆；2 = 读不了库或参数错。
 * 采集器停摆（标题 `[信源巡检] 采集器停摆 …`）与坏掉的源走同一套开 issue / 去重 / 重开逻辑。
 *
 * 怎么定时：不在这里配。部署在本机，所以用本机的计划任务每天跑一次 `pnpm sources:patrol --open-issues`
 * （Linux/macOS 的 cron、Windows 的任务计划程序都行）。没有选「采集器 tick 触发」：那要把 GitHub 凭据交给 Nitro 进程、
 * 在进程里再记一份「今天报过没有」的状态，比一条 crontab 复杂；而且服务停了巡检也跟着停，偏偏停摆才最需要报。
 * 验收「坏掉后 24 小时内报出来」：每天一次的巡检 + 阈值里的 60 分钟，最坏约 24 小时 + 1 小时。
 * 需要 `gh` 已登录，且账号能在 XartLab/KATANAview 开 issue。只读库，可以在服务运行时跑。
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { promisify } from "node:util"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { projectDir } from "../shared/dir"
import _sources from "../shared/sources.json"
import { ObservationStore } from "../server/collector/store"
import { MUTED_LABEL, PATROL_DEFAULTS, buildPatrolReport, openIssues } from "../server/collector/patrol"
import type { PatrolSourceMeta } from "../server/collector/patrol"

const sources = _sources as Record<string, PatrolSourceMeta>

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const flag = (name: string) => process.argv.includes(`--${name}`)
function positive(name: string, fallback: number) {
  const raw = arg(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${name} 要正整数，拿到 ${raw}`)
    process.exit(2)
  }
  return n
}

const dbPath = arg("db") ?? join(projectDir, ".data/db.sqlite3")
if (!existsSync(dbPath)) {
  console.error(`找不到数据库 ${dbPath}；采集器还没跑过，或用 --db 指定路径`)
  process.exit(2)
}
const db = createDatabase(sqlite({ path: dbPath }))
const hasTable = await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'source_health'").get()
if (!hasTable) {
  console.error("库里还没有 source_health 表：采集器还没跑过一轮")
  process.exit(2)
}

// 只读：不调用 store.init()，不建表、不改库
const health = await new ObservationStore(db).getHealth()
const report = buildPatrolReport(health, sources, Date.now(), {
  minFailures: positive("min-failures", PATROL_DEFAULTS.minFailures),
  minFailingMinutes: positive("min-minutes", PATROL_DEFAULTS.minFailingMinutes),
  collectorStalledMinutes: positive("stalled-minutes", PATROL_DEFAULTS.collectorStalledMinutes),
})

const execFileAsync = promisify(execFile)
const issues = flag("open-issues")
  ? await openIssues(report, {
    repo: arg("repo") ?? "XartLab/KATANAview",
    label: arg("label") ?? "area:news",
    dryRun: flag("dry-run"),
    runGh: async args => (await execFileAsync("gh", args, { maxBuffer: 16 * 1024 * 1024 })).stdout,
  }).catch((e) => {
    console.error(`开 issue 失败：${e instanceof Error ? e.message : e}`)
    process.exit(2)
  })
  : undefined

if (arg("format") === "text") {
  const line = (f: typeof report.failing[number]) =>
    `${f.sourceId.padEnd(24)} 连续失败 ${String(f.consecutiveFailures).padStart(4)} 次  ${f.minutesSinceLastSuccess === null ? "从未成功" : `${f.minutesSinceLastSuccess} 分钟没成功`}  ${(f.lastError ?? "").slice(0, 80)}`
  console.log(`巡检时间 ${report.generatedAtIso}；正常 ${report.okCount}，要报 ${report.failing.length}，观察 ${report.watching.length}，没抓过 ${report.pending.length}`)
  if (report.collector.stalled) console.log(`采集器停摆：最近一次尝试在 ${report.collector.minutesSinceLastAttempt} 分钟前`)
  if (report.failing.length) console.log(`\n要报：\n${report.failing.map(line).join("\n")}`)
  if (report.watching.length) console.log(`\n观察（没到阈值）：\n${report.watching.map(line).join("\n")}`)
  if (report.pending.length) console.log(`\n没抓过：${report.pending.join(", ")}`)
  if (issues) {
    console.log(`\nissue${issues.labelMissing ? `（标签 ${arg("label") ?? "area:news"} 不存在，没加标签）` : ""}${issues.mutedLabelMissing ? `（静音标签 ${MUTED_LABEL} 不存在，静音不生效；建了这个标签后，带它的已关闭 issue 永不重开）` : ""}：`)
    for (const a of issues.actions) console.log(`${a.action.padEnd(12)} ${a.title}${a.url ? ` ${a.url}` : ""}`)
  }
} else {
  console.log(JSON.stringify({ ...report, issues }, undefined, 2))
}
process.exit(report.unhealthy ? 1 : 0)
