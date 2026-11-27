/**
 * 批量标注的影响类型准确率（#2188 补充）。需要人工标 gold，流程见 server/enrich/tag-eval.ts 的文件头。
 *   pnpm enrich:tag-eval --sample 100 --out sample.json [--db path] [--seed 1]   # 从库里随机抽已标注的组
 *   pnpm enrich:tag-eval --score sample.json [--verbose]                          # 人工填完 gold 之后算准确率
 * 抽样在已标注的组里均匀随机（带种子，可重现）；没有标注过的库抽不出来。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { projectDir } from "../shared/dir"
import { ObservationStore } from "../server/collector/store"
import { EnrichStore } from "../server/enrich/store"
import { marketsOf } from "../server/enrich/align"
import { scoreTags } from "../server/enrich/tag-eval"
import type { TagSample } from "../server/enrich/tag-eval"

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1] ?? "1"
}
const pct = (x: number) => Number.isNaN(x) ? "无（没有已标注的条目）" : `${(x * 100).toFixed(1)}%`

const scorePath = arg("score")
if (scorePath) {
  const samples = (JSON.parse(readFileSync(scorePath, "utf8")) as { samples: TagSample[] }).samples
  const s = scoreTags(samples)
  console.log(`样本 ${s.samples} 条，人工标了影响类型的 ${s.impactLabeled} 条、方向的 ${s.directionLabeled} 条`)
  console.log(`影响类型准确率 ${pct(s.impactAccuracy)}（${s.impactCorrect}/${s.impactLabeled}，其中模型没给类型的 ${s.impactMissing} 条算错）`)
  console.log(`方向准确率 ${pct(s.directionAccuracy)}（${s.directionCorrect}/${s.directionLabeled}）`)
  if (process.argv.includes("--verbose")) {
    for (const w of s.wrong) console.log(`错  gold=${w.gold}  模型=${w.predicted ?? "null"}  ${w.title}`)
  }
  process.exit(0)
}

const n = Number(arg("sample"))
const out = arg("out")
if (!Number.isInteger(n) || n < 1 || !out) {
  console.error("用法：--sample N --out file.json，或 --score file.json")
  process.exit(2)
}
const dbPath = arg("db") ?? join(projectDir, ".data/db.sqlite3")
if (!existsSync(dbPath)) {
  console.error(`找不到数据库 ${dbPath}`)
  process.exit(2)
}
const db = createDatabase(sqlite({ path: dbPath }))
await new ObservationStore(db).init()
const store = new EnrichStore(db)
// 种子化的洗牌（mulberry32），同一个种子同一个库抽到同一批
let seed = Number(arg("seed") ?? 1) >>> 0
function rand() {
  seed = (seed + 0x6D2B79F5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const seqs = ((await db.prepare(`SELECT seq FROM items WHERE tagged > 0 ORDER BY seq`).all()) as { seq: number }[]).map(r => r.seq)
if (!seqs.length) {
  console.error("库里没有已标注的组（没配模型，或还没标过）：先 pnpm enrich:tag。")
  process.exit(3)
}
for (let i = seqs.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [seqs[i], seqs[j]] = [seqs[j], seqs[i]]
}
const samples: TagSample[] = []
for (const seq of seqs.slice(0, n)) {
  const item = await store.item(seq)
  if (!item?.tags) continue
  samples.push({ seq, title: item.cleanTitle ?? item.title, market: marketsOf(item.symbols, item.sourceId)[0], predicted: item.tags, gold: { impact: null, direction: null } })
}
writeFileSync(out, `${JSON.stringify({ note: "人工填 gold.impact（分类表里的名称）与 gold.direction（bull / bear / neutral），再用 --score 算准确率", samples }, null, 2)}\n`)
console.log(`抽了 ${samples.length} 组（库里已标注 ${seqs.length} 组），写到 ${out}`)
