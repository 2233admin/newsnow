/**
 * 从采集库里按固定随机种子抽财经快讯，写成待标注的样本（#2188 验收：抽样 200 条报准确率与召回率）。
 *
 *   pnpm exec tsx scripts/enrich-sample.ts --db .data/db.sqlite3 --n 200 --seed 2188 --out .scratchpad/sample.json
 *
 * 抽样池：新闻类信源（金十、财联社、华尔街见闻、同花顺、格隆汇、FastBull、MKTNews、36氪快讯等）的条目，按 (source_id, item_id) 排序后
 * 用 mulberry32 洗牌取前 n 条，种子与排序都固定，同一个库抽出同一批。输出里没有任何识别结果，标注时不看识别器的输出。
 */
import process from "node:process"
import { writeFileSync } from "node:fs"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const POOL = ["jin10", "cls-telegraph", "cls-depth", "wallstreetcn-quick", "wallstreetcn-news", "ths", "gelonghui", "fastbull-express", "fastbull-news", "mktnews-flash", "36kr-quick"]

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const db = createDatabase(sqlite({ path: arg("db")! }))
const rows = await db.prepare(`
  SELECT source_id, item_id, title FROM items WHERE source_id IN (${POOL.map(() => "?").join(",")}) ORDER BY source_id, item_id
`).all(...POOL) as { source_id: string, item_id: string, title: string }[]
const rand = mulberry32(Number(arg("seed", "2188")))
for (let i = rows.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [rows[i], rows[j]] = [rows[j], rows[i]]
}
const n = Math.min(Number(arg("n", "200")), rows.length)
const sample = rows.slice(0, n).map(r => ({ id: `${r.source_id}/${r.item_id}`, source: r.source_id, title: r.title }))
writeFileSync(arg("out")!, `${JSON.stringify(sample, null, 1)}\n`)
console.log(`池 ${rows.length} 条，抽 ${n} 条`)
