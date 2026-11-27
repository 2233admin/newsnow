import impactData from "./config/impact-types.json"
import { isRecord, need, resolveConfig } from "./config"
import { MARKETS } from "./types"
import type { Market } from "./types"

/**
 * 影响类型分类表（#2188 补充）：按市场分，放在 config/impact-types.json，用户可改。
 * 批量标注的提示词从这里生成；模型返回的类型必须在这张表里，不在的记 null（不造假、不硬归类）。
 */

export interface ImpactType {
  name: string
  hint: string
}

export type ImpactConfig = Record<Market, { label: string, types: ImpactType[] }>

export function parseImpactConfig(raw: unknown): ImpactConfig {
  need(isRecord(raw) && isRecord(raw.markets), "impact-types.json 缺少 markets")
  const out = {} as ImpactConfig
  for (const market of MARKETS) {
    const m = raw.markets[market]
    need(isRecord(m), `impact-types.json 缺少市场 ${market}`)
    need(Array.isArray(m.types) && m.types.length > 0, `${market}.types 须是非空数组`)
    const seen = new Set<string>()
    const types = (m.types as unknown[]).map((t) => {
      need(isRecord(t) && typeof t.name === "string", `${market}.types 的每项须有 name`)
      const name = t.name.trim()
      need(name.length > 0 && name.length <= 20, `${market} 的类型名「${name}」须在 1–20 个字之间`)
      need(!/["\\\n]/.test(name), `${market} 的类型名「${name}」不能含引号、反斜杠、换行`)
      need(!seen.has(name), `${market} 的类型名「${name}」重复`)
      seen.add(name)
      return { name, hint: typeof t.hint === "string" ? t.hint : "" }
    })
    out[market] = { label: typeof m.label === "string" ? m.label : market, types }
  }
  return out
}

let cached: ImpactConfig | undefined
export function getImpactConfig(): ImpactConfig {
  return cached ??= resolveConfig("impact-types", impactData, parseImpactConfig)
}
export function resetImpactConfig() {
  cached = undefined
}
