/**
 * 本机自检：读采集库，逐个源打印观测数、采集轮数、条目数与健康状态，
 * 有源一条观测也没有就以非零退出码结束（#2184 验收「所有源都有观测记录」）。
 * 内置源之外，已启用的用户源（`user:<slug>`，含预置订阅包启用的）也逐个列出、同样计入。
 *
 * 用法（先让服务跑一阵：`pnpm build && pnpm start`，或 `pnpm dev`）：
 *   pnpm collector:check                       # 读 .data/db.sqlite3
 *   pnpm collector:check --db path/to/db.sqlite3 --min-observations 10
 * 只做读取，可以在服务运行时跑。只适用于默认的 better-sqlite3 部署。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { projectDir } from "../shared/dir"
import _sources from "../shared/sources.json"
import { readEnabledUserSources } from "../server/registry/patrol-sources"

interface SourceMeta {
  interval: number
  redirect?: string
}
const builtin = _sources as Record<string, SourceMeta>

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const dbPath = arg("db") ?? join(projectDir, ".data/db.sqlite3")
const minObservations = Number(arg("min-observations") ?? 1)
if (!existsSync(dbPath)) {
  console.error(`找不到数据库 ${dbPath}；先让服务跑一阵，或用 --db 指定路径`)
  process.exit(2)
}

const db = createDatabase(sqlite({ path: dbPath }))
const sources: Record<string, SourceMeta> = { ...builtin, ...await readEnabledUserSources(db) }
const all = async (sql: string) => await db.prepare(sql).all() as any[]
const tables = new Set((await all("SELECT name FROM sqlite_master WHERE type = 'table'")).map(r => r.name))
if (!tables.has("observations") || !tables.has("source_health")) {
  console.error("库里还没有采集表：服务还没跑过一轮采集")
  process.exit(2)
}

const obs = new Map((await all(`
  SELECT source_id, COUNT(*) AS n, COUNT(DISTINCT observed_at) AS cycles, MIN(observed_at) AS first_at, MAX(observed_at) AS last_at
  FROM observations GROUP BY source_id
`)).map(r => [r.source_id, r]))
const items = new Map((await all(`SELECT source_id, COUNT(*) AS n FROM items GROUP BY source_id`)).map(r => [r.source_id, r.n]))
const health = new Map((await all(`SELECT * FROM source_health`)).map(r => [r.source_id, r]))

const now = Date.now()
const minutes = (ms: number) => `${Math.round(ms / 60000)}m`
let missing = 0
let failing = 0
console.log(["source".padEnd(26), "interval", "cycles", "~expected", "obs".padStart(7), "items".padStart(6), "health"].join("  "))
for (const [id, meta] of Object.entries(sources)) {
  if (meta.redirect) continue
  const o = obs.get(id)
  const h = health.get(id)
  const span = o ? o.last_at - o.first_at : 0
  const expected = o ? Math.floor(span / meta.interval) + 1 : 0
  if (!o || o.n < minObservations) missing++
  if (h?.consecutive_failures > 0) failing++
  const status = !h
    ? "never attempted"
    : h.consecutive_failures > 0
      ? `FAILING x${h.consecutive_failures}: ${String(h.last_error).slice(0, 60)}`
      : `ok, last success ${minutes(now - h.last_success_at)} ago`
  console.log([
    id.padEnd(26),
    minutes(meta.interval).padStart(8),
    String(o?.cycles ?? 0).padStart(6),
    String(expected).padStart(9),
    String(o?.n ?? 0).padStart(7),
    String(items.get(id) ?? 0).padStart(6),
    status,
  ].join("  "))
}
const total = Object.values(sources).filter(s => !s.redirect).length
console.log(`\n${total - missing}/${total} 个源有至少 ${minObservations} 条观测；${failing} 个源当前处于连续失败`)
process.exit(missing ? 1 : 0)
