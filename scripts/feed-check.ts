/**
 * 本机自检：对运行中的服务验收新闻流接口（#2186），只读，经 HTTP，不 import 服务端代码。
 *
 * 1. 翻页：从头按游标翻到底，断言没有重复、顺序严格递减（排序键 feedTs、sourceId、itemId）；
 *    给了 --db 时再与库里 items 的行数对账（一条不少）。
 * 2. 首屏延迟：连发 --runs 次 GET /api/feed，打印 p50 / p95 / 最大（毫秒），超过 --max-ms 以非零退出码结束。
 *
 * 用法（服务已在跑；Host 须是 localhost / 127.0.0.1，见 server/registry/http.ts）：
 *   pnpm feed:check --base http://127.0.0.1:3161 --db .data/db.sqlite3
 * 翻页时带 includeInactive=1，所以库里停用与已删除的源的条目也算进来，行数才对得上。
 */
import { existsSync } from "node:fs"
import process from "node:process"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const base = arg("base") ?? "http://127.0.0.1:4444"
const dbPath = arg("db")
const runs = Number(arg("runs") ?? 200)
const maxMs = Number(arg("max-ms") ?? 200)
const pageSize = Number(arg("limit") ?? 200)

interface Item {
  seq: number
  sourceId: string
  itemId: string
  feedTs: number
}
interface Page {
  items: Item[]
  nextCursor: string | null
  latestSeq: number
}

async function get(path: string): Promise<Page> {
  const res = await fetch(`${base}${path}`)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`)
  return await res.json() as Page
}

const after = (a: Item, b: Item) => a.feedTs > b.feedTs || (a.feedTs === b.feedTs && (a.sourceId > b.sourceId || (a.sourceId === b.sourceId && a.itemId > b.itemId)))

let failed = false
function fail(msg: string) {
  failed = true
  console.error(`FAIL ${msg}`)
}

// 1. 翻页
const seen = new Set<string>()
let prev: Item | undefined
let cursor: string | undefined
let pages = 0
let total = 0
for (;;) {
  const page = await get(`/api/feed?includeInactive=1&limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
  pages++
  for (const item of page.items) {
    const key = `${item.sourceId}\u0000${item.itemId}`
    if (seen.has(key)) fail(`重复：${item.sourceId}/${item.itemId}`)
    seen.add(key)
    if (prev && !after(prev, item)) fail(`顺序不对：${prev.sourceId}/${prev.itemId} 之后是 ${item.sourceId}/${item.itemId}`)
    prev = item
    total++
  }
  if (!page.nextCursor) break
  cursor = page.nextCursor
}
console.log(`翻页：${pages} 页，${total} 条，不重复 ${seen.size} 条`)

if (dbPath) {
  if (!existsSync(dbPath)) {
    console.error(`找不到数据库 ${dbPath}`)
    process.exit(2)
  }
  const db = createDatabase(sqlite({ path: dbPath, readonly: true }))
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }
  console.log(`库里 items：${n} 行`)
  // 翻页期间服务还在采集会多出新条目：翻到的只能比开始时的多，不能少
  if (seen.size < n) fail(`漏了 ${n - seen.size} 条（翻到 ${seen.size}，库里 ${n}）`)
}

// 2. 首屏延迟
async function measure(label: string, path: string) {
  const times: number[] = []
  await get(path) // 预热：第一次要建连接、编译语句
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    await get(path)
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const q = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))]
  const p95 = q(0.95)
  console.log(`${label.padEnd(28)} p50 ${q(0.5).toFixed(1)} ms  p95 ${p95.toFixed(1)} ms  max ${times.at(-1)!.toFixed(1)} ms  （${runs} 次）`)
  if (p95 > maxMs) fail(`${label} p95 ${p95.toFixed(1)} ms 超过 ${maxMs} ms`)
}
await measure("首屏（默认 50 条）", "/api/feed")
await measure("首屏（200 条）", "/api/feed?limit=200")
await measure("按来源", "/api/feed?source=jin10")
await measure("按关键词", `/api/feed?q=${encodeURIComponent("黄金")}`)
await measure("按分类 + 时间范围", `/api/feed?category=finance&from=${Date.now() - 86_400_000}`)

process.exit(failed ? 1 : 0)
