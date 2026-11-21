import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import { describe, expect, it } from "vitest"
import { score } from "#/enrich/eval"
import type { Labeled } from "#/enrich/eval"
import { extractSymbols } from "#/enrich/symbols"
import ashare from "#/enrich/dict/ashare.json"
import us from "#/enrich/dict/us.json"
import crypto from "#/enrich/dict/crypto.json"

const samples = (JSON.parse(readFileSync(resolve(process.cwd(), "test/fixtures/enrich-sample.json"), "utf8")) as { samples: Labeled[] }).samples
const dict = new Set<string>([
  ...ashare.map(r => `${r[0]}.${{ sh: "XSHG", sz: "XSHE", bj: "BJSE" }[r[1] as string]}`),
  ...us.map(r => `${r[0]}.${r[1]}`),
  ...crypto.map(r => r[1] as string),
])

// 回归下限，不是目标：写下时的实测是准确率 100%、召回率 97.4%（200 条、39 对，见 scripts/enrich-eval.ts）。
// 样本小（39 对），下限留出一两对的余量；掉到下限以下就是识别器退步了，先查是哪条规则改坏的，再决定是改规则还是改样本。
describe("标的识别的标注样本回归", () => {
  const s = score(samples, extractSymbols, id => dict.has(id))

  it("样本是 200 条，三个市场都有标注", () => {
    expect(s.titles).toBe(200)
    expect(s.goldPairs).toBeGreaterThanOrEqual(35)
    const gold = samples.flatMap(x => x.symbols)
    expect(gold.some(id => /\.(?:XSHG|XSHE|BJSE)$/.test(id))).toBe(true)
    expect(gold.some(id => /\.(?:XNAS|XNYS)$/.test(id))).toBe(true)
    expect(gold.some(id => id.endsWith(".BINANCE"))).toBe(true)
  })

  it("准确率不低于 95%", () => {
    expect(s.falsePositives).toEqual([])
    expect(s.precision).toBeGreaterThanOrEqual(0.95)
  })

  it("召回率不低于 90%", () => {
    expect(s.recall).toBeGreaterThanOrEqual(0.9)
  })
})
