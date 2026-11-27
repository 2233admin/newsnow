/**
 * 批量标注（#2188 补充）：对本地 better-sqlite3 库追标注积压，或看进度、重标。服务在跑时每分钟会自己补一轮（见 server/enrich/tagger.ts），
 * 这个脚本用来一次追完历史条目、改了影响类型分类表之后重标。模型与 key 用环境变量（见 server/enrich/llm.ts）；没配就只报进度，不调用。
 *
 * 用法：
 *   pnpm enrich:tag                       # 读 .data/db.sqlite3，把待标注的组标完（调模型）
 *   pnpm enrich:tag --status              # 只看进度，不调模型
 *   pnpm enrich:tag --retry-failed        # 只把失败到上限放弃的组放回待标注（已标好的不动、不重付费），再接着标
 *   pnpm enrich:tag --redo                # 清掉全部标注与失败计数，回到待标注（改了分类表后）；加 --status 以外的参数会接着重标
 *   pnpm enrich:tag --db path/to/db.sqlite3
 *   pnpm enrich:tag --sources jin10,cls-telegraph   # 只标这几个来源（默认不限来源：脚本读不到用户源的分类；服务里是按 ENRICH_TAG_CATEGORIES 限的）
 * 与服务同时跑没有问题：只写标注那几列，不动分组。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { projectDir } from "../shared/dir"
import { ObservationStore } from "../server/collector/store"
import { EnrichStore } from "../server/enrich/store"
import { createLlm, readTagLlm } from "../server/enrich/llm"
import { MAX_TAG_ATTEMPTS, createTagger } from "../server/enrich/tagger"

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
await new ObservationStore(db).init()
const store = new EnrichStore(db)
async function show(label: string) {
  const c = await store.tagCounts(MAX_TAG_ATTEMPTS)
  console.log(`${label}：已标 ${c.tagged} 组，待标 ${c.pending} 组，失败到上限放弃 ${c.gaveUp} 组`)
}
if (process.argv.includes("--retry-failed")) console.log(`把 ${await store.resetFailedTags(MAX_TAG_ATTEMPTS)} 组失败放弃的放回待标注（已标好的不动）`)
if (process.argv.includes("--redo")) console.log(`清掉了 ${await store.resetTags()} 组的标注，回到待标注`)
await show("现状")
if (process.argv.includes("--status")) process.exit(0)
const cfg = readTagLlm()
if (!cfg) {
  console.error("没有配置模型（ENRICH_LLM_PROVIDER / ENRICH_LLM_API_KEY / ENRICH_LLM_MODEL），不调用。")
  process.exit(3)
}
const sources = arg("sources")?.split(",").map(s => s.trim()).filter(Boolean) ?? null
const tagger = createTagger({ store, llm: createLlm(cfg), sourceIds: async () => sources })
const started = Date.now()
const total = await tagger.drain(t => console.log(`  调用 ${t.calls} 次，标了 ${t.tagged} 组，失败 ${t.failed} 组`))
console.log(`完成：调用 ${total.calls} 次，标了 ${total.tagged} 组，失败 ${total.failed} 组，${((Date.now() - started) / 1000).toFixed(1)} 秒${total.error ? `；中止于模型接口错误：${total.error}` : ""}`)
await show("现在")
process.exit(total.error ? 1 : 0)
