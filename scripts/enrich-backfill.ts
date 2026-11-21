/**
 * 回填富化（#2188）：给还没富化的历史条目补上清洗标题、标的与去重分组；或词典更新后重算标的。
 *
 * 用法（对本地 better-sqlite3 库；**先停服务**：回填与服务同时写同一个库会各自按自己看到的分组，规则见 server/enrich/enrich.ts）：
 *   pnpm enrich:backfill                         # 读 .data/db.sqlite3，补所有 enriched = 0 的条目
 *   pnpm enrich:backfill --db path/to/db.sqlite3
 *   pnpm enrich:backfill --symbols               # 词典更新后：只重算全部条目的清洗标题与标的，不动分组
 *   --force                                      # 跳过「最近有采集写入就拒绝」的检查（确认没有别的进程在写再用）
 * 回填会让一部分老条目变成别的条目的成员，从默认流里消失（它们仍在 expand=1 里）；只补没富化过的，所以重复跑不会再动已经分好的组。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { projectDir } from "../shared/dir"
import { ObservationStore } from "../server/collector/store"
import { collectorLooksActive, createEnricher } from "../server/enrich/enrich"

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1] ?? "1"
}

const dbPath = arg("db") ?? join(projectDir, ".data/db.sqlite3")
if (!existsSync(dbPath)) {
  console.error(`找不到数据库 ${dbPath}`)
  process.exit(2)
}
const db = createDatabase(sqlite({ path: dbPath }))
// 先走一遍建表与迁移（补富化的列），同服务启动时一样
await new ObservationStore(db).init()
const enricher = createEnricher(db)
const last = await enricher.store.lastCollectorWriteAt()
if (collectorLooksActive(last, Date.now()) && !process.argv.includes("--force")) {
  console.error(`库在 ${Math.round((Date.now() - last) / 1000)} 秒前还有采集写入（服务可能还在跑）：回填和服务同时处理同一批条目会让分组出链。`
    + `先停服务再回填；确认没有别的进程在写，才加 --force。`)
  process.exit(3)
}
const batch = Number(arg("batch") ?? 200)
const started = Date.now()
function progress(done: number) {
  if (done % (batch * 10) === 0) console.log(`  已处理 ${done} 条`)
}
if (arg("symbols")) {
  const n = await enricher.resymbol(batch, progress)
  console.log(`重算了 ${n} 条的清洗标题与标的，${((Date.now() - started) / 1000).toFixed(1)} 秒`)
} else {
  const before = await enricher.store.counts()
  const n = await enricher.backfill(batch, progress)
  const after = await enricher.store.counts()
  console.log(`回填了 ${n} 条（共 ${before.total} 条，之前未富化 ${before.pending}，现在 ${after.pending}），${((Date.now() - started) / 1000).toFixed(1)} 秒`)
}
