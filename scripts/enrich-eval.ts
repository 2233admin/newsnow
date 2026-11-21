/**
 * 标的识别的准确率与召回率（#2188）：用标注样本 test/fixtures/enrich-sample.json 评测当前词典与规则。
 *   pnpm exec tsx scripts/enrich-eval.ts [--verbose]
 */
import { readFileSync } from "node:fs"
import process from "node:process"
import { score } from "../server/enrich/eval"
import type { Labeled } from "../server/enrich/eval"
import { extractSymbols } from "../server/enrich/symbols"
import ashare from "../server/enrich/dict/ashare.json"
import us from "../server/enrich/dict/us.json"
import crypto from "../server/enrich/dict/crypto.json"

const samples = (JSON.parse(readFileSync(new URL("../test/fixtures/enrich-sample.json", import.meta.url), "utf8")) as { samples: Labeled[] }).samples
const dict = new Set<string>([
  ...ashare.map(r => `${r[0]}.${{ sh: "XSHG", sz: "XSHE", bj: "BJSE" }[r[1] as string]}`),
  ...us.map(r => `${r[0]}.${r[1]}`),
  ...crypto.map(r => r[1] as string),
])
const s = score(samples, extractSymbols, id => dict.has(id))
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
console.log(`样本 ${s.titles} 条（有标的的 ${s.titlesWithGold} 条），标注 ${s.goldPairs} 对（词典内 ${s.goldInDict} 对），识别 ${s.predicted} 对，命中 ${s.tp} 对`)
console.log(`准确率 ${pct(s.precision)}  召回率 ${pct(s.recall)}（词典内 ${pct(s.recallInDict)}）`)
if (process.argv.includes("--verbose")) {
  for (const f of s.falsePositives) console.log(`误报  ${f.id}  ${f.title}`)
  for (const m of s.misses) console.log(`漏报  ${m.id}${m.inDict ? "" : "（词典外）"}  ${m.title}`)
}
