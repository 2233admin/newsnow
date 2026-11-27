import process from "node:process"
import { logger } from "../utils/logger"
import type { IngestedItem } from "../collector/store"
import { marketsOf } from "./align"
import { getImpactConfig } from "./impact"
import type { ImpactConfig } from "./impact"
import { LlmError } from "./llm"
import type { LlmCall } from "./llm"
import type { EnrichStore, TagRow } from "./store"
import { DIRECTIONS } from "./types"
import type { Direction, Market } from "./types"

/**
 * 批量标注层（#2188 补充）：便宜模型打包调用，多条一次请求，返回紧凑 JSON。
 * 结构参照 owengetinfo-design/PokieTicker 的 backend/pipeline/layer1.py（MIT License，Copyright (c) 2025 PokieTicker）：
 * 一次请求打包 50 条左右、要求只返回紧凑的 JSON 数组（短键 i / r / s / e，省输出）、按 `[` 到 `]` 截取再解析。
 * 与它不同的地方：
 * - 它按单个标的问「这篇对 X 是涨是跌、为什么」，这里不问涨跌，只问这条新闻本身的读法（方向 = 正面 positive / 负面 negative / 中性 neutral，不是涨跌）、影响类型、一句话要点与相关题材；
 * - 解析更宽容：返回被截断、夹带说明文字、少了某条时，能解析出来的照收，其余字段 null，不整批作废；
 * - 每组（去重后的主条目）只标一次，被规则层过滤的不标；
 * - 没配模型时整层跳过，字段保持 null，不报错、不造假。
 *
 * 触发：采集每分钟的心跳之后（server/tasks/collect/tick.ts）后台跑一轮（单飞），每轮最多 MAX_BATCHES_PER_RUN 次调用；
 * 积压（历史条目、刚配上模型）也靠这个慢慢追，或用 `pnpm enrich:tag` 一次追完。模型接口出错就退避一段时间，不连环重试。
 */

/** 一次请求打包的条数。layer0/1 参照的是 50；中文标题加提示词更长一些，取 40。待定：没有按所选模型的实际输出上限量过。 */
export const TAG_BATCH_SIZE = 40
/** 输出上限：每条约 60–80 个 token（短键 JSON + 一句话要点 + 题材），40 条留足余量。 */
export const TAG_MAX_OUTPUT_TOKENS = 4096
/** 每轮（每分钟）最多调用几次。待定：按「每分钟入库几十条」估的，积压靠 enrich:tag 追。 */
export const DEFAULT_MAX_BATCHES_PER_RUN = 2
/** 一组连续失败这么多次（模型没返回它、或返回的整条不可用）就不再自动重试。 */
export const MAX_TAG_ATTEMPTS = 3
/** 模型接口出错后，这么久之内不再调用。待定。 */
export const ERROR_BACKOFF_MS = 5 * 60_000
export const TAG_VERSION = 1
const MAX_TITLE_CHARS = 200
const MAX_GIST_CHARS = 80
const MAX_THEMES = 5
const MAX_THEME_CHARS = 24

// ---- 提示词

export function buildTagPrompt(market: Market, titles: string[], impact: ImpactConfig = getImpactConfig()): { system: string, user: string } {
  const table = impact[market]
  const system = "你是财经新闻的分类标注器。只依据给出的标题标注，不要补充标题里没有的事实；你的判断只是对这条新闻本身的读法（好消息还是坏消息），不是对价格涨跌的预测：不要预测价格，不要判断对股价的影响，不给买卖建议。只输出 JSON，不要解释，不要代码块。"
  const types = table.types.map(t => `- ${t.name}${t.hint ? `：${t.hint}` : ""}`).join("\n")
  const lines = titles.map((t, i) => `[${i}] ${t.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS)}`).join("\n")
  const user = `市场：${table.label}
影响类型（t 只能从下面原样选一个名称；都不合适就选「其他」）：
${types}

给下面 ${titles.length} 条新闻各标一条，只返回 JSON 数组：
[{"i":0,"t":"影响类型","d":"+","g":"一句话要点","k":["题材"]}]
i：新闻序号。
t：影响类型，见上表。
d：这条新闻本身读起来是好消息还是坏消息："+" 正面、"-" 负面、"0" 中性或无法判断。只判断新闻本身，不要预测价格涨跌，不要判断对股价的影响。
g：一句话要点，不超过 ${MAX_GIST_CHARS / 2} 个字，只复述标题里有的信息。
k：相关题材或板块，至多 ${MAX_THEMES} 个，没有就给 []。

新闻：
${lines}
JSON：`
  return { system, user }
}

// ---- 解析

export interface ParsedTag {
  impact: string | null
  direction: Direction | null
  gist: string | null
  themes: string[] | null
}

/**
 * 从模型的文本里捞出顶层的 JSON 对象（逐个解析，坏的跳过）。能处理：夹带说明文字、代码块围栏、数组被截断（最后一个对象没写完）、
 * 整体包在 {"results":[…]} 里。返回解析出的对象，按出现顺序。
 */
export function extractObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === "\"") inString = false
      continue
    }
    if (c === "\"" && depth > 0) {
      inString = true
    } else if (c === "{") {
      if (depth === 0) start = i
      depth++
    } else if (c === "}" && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1))
          if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as Record<string, unknown>)
        } catch {}
        start = -1
      }
    }
  }
  // 整体包了一层 {"results":[…]}：顶层对象里没有 i，但有数组，往里取
  if (out.length === 1 && !("i" in out[0])) {
    const inner = Object.values(out[0]).find((v): v is unknown[] => Array.isArray(v) && v.some(x => !!x && typeof x === "object" && !Array.isArray(x)))
    if (inner) return inner.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
  }
  return out
}

function direction(v: unknown): Direction | null {
  if (typeof v !== "string") return null
  const s = v.trim().toLowerCase()
  if (["+", "positive", "pos", "bull", "bullish", "正面", "利好", "多"].includes(s)) return "positive"
  if (["-", "negative", "neg", "bear", "bearish", "负面", "利空", "空"].includes(s)) return "negative"
  if (["0", "neutral", "中性", "无"].includes(s)) return "neutral"
  return (DIRECTIONS as readonly string[]).includes(s) ? s as Direction : null
}

function themes(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== "string") continue
    const t = x.trim().slice(0, MAX_THEME_CHARS)
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= MAX_THEMES) break
  }
  return out
}

/**
 * 解析一次批量返回。count = 这次发了几条（序号 0..count-1）；allowed = 该市场分类表里的类型名。
 * 返回 序号 → 标注；模型没返回的序号不在里面；每个字段单独校验，不合格的记 null（影响类型不在表里也是 null：不硬归类）。
 * 一条的四个字段全是 null 的不收（等于没返回）。同一个序号出现两次，取先出现的。
 */
export function parseTagResponse(text: string, count: number, allowed: string[]): Map<number, ParsedTag> {
  const out = new Map<number, ParsedTag>()
  const names = new Set(allowed)
  for (const o of extractObjects(text)) {
    const i = typeof o.i === "number" ? o.i : typeof o.i === "string" && /^\d+$/.test(o.i) ? Number(o.i) : Number.NaN
    if (!Number.isInteger(i) || i < 0 || i >= count || out.has(i)) continue
    const impact = typeof o.t === "string" && names.has(o.t.trim()) ? o.t.trim() : null
    const gist = typeof o.g === "string" && o.g.trim() ? o.g.trim().slice(0, MAX_GIST_CHARS) : null
    const tag: ParsedTag = { impact, direction: direction(o.d), gist, themes: themes(o.k) }
    if (tag.impact === null && tag.direction === null && tag.gist === null && tag.themes === null) continue
    out.set(i, tag)
  }
  return out
}

// ---- 一轮

export interface TaggerDeps {
  store: EnrichStore
  llm: LlmCall
  /** 要标的来源 id；null = 不限来源 */
  sourceIds: () => Promise<string[] | null>
  impact?: () => ImpactConfig
  clock?: () => number
  batchSize?: number
  maxBatchesPerRun?: number
}

export interface TagRunResult {
  calls: number
  tagged: number
  /** 这一轮里没拿到可用结果的组数（计失败一次） */
  failed: number
  /** 模型接口出错中止了这一轮 */
  error?: string
}

export function createTagger(deps: TaggerDeps) {
  const { store, llm } = deps
  const clock = deps.clock ?? Date.now
  const batchSize = deps.batchSize ?? TAG_BATCH_SIZE
  let blockedUntil = 0
  let running: Promise<TagRunResult> | undefined

  async function tagBatch(market: Market, items: IngestedItem[], impact: ImpactConfig): Promise<{ tagged: number, failed: number }> {
    const { system, user } = buildTagPrompt(market, items.map(i => i.cleanTitle ?? i.title), impact)
    const text = await llm({ system, user, maxTokens: TAG_MAX_OUTPUT_TOKENS })
    const parsed = parseTagResponse(text, items.length, impact[market].types.map(t => t.name))
    const rows: TagRow[] = []
    const failed: number[] = []
    items.forEach((item, i) => {
      const p = parsed.get(i)
      if (p) rows.push({ seq: item.seq, ...p })
      else failed.push(item.seq)
    })
    if (rows.length) await store.saveTags(rows, TAG_VERSION)
    if (failed.length) await store.bumpTagAttempts(failed)
    return { tagged: rows.length, failed: failed.length }
  }

  async function runOnce(maxBatches: number): Promise<TagRunResult> {
    const result: TagRunResult = { calls: 0, tagged: 0, failed: 0 }
    if (clock() < blockedUntil) return result
    const impact = (deps.impact ?? getImpactConfig)()
    const sourceIds = await deps.sourceIds()
    // 一次取够这一轮要用的条数，按市场分堆（各市场的分类表不同），每堆再切成批
    const pending = await store.pendingTags(batchSize * maxBatches, MAX_TAG_ATTEMPTS, sourceIds)
    const byMarket = new Map<Market, IngestedItem[]>()
    for (const item of pending) {
      const market = marketsOf(item.symbols, item.sourceId)[0]
      const list = byMarket.get(market)
      if (list) list.push(item)
      else byMarket.set(market, [item])
    }
    for (const [market, items] of byMarket) {
      for (let i = 0; i < items.length; i += batchSize) {
        if (result.calls >= maxBatches) return result
        result.calls++
        try {
          const r = await tagBatch(market, items.slice(i, i + batchSize), impact)
          result.tagged += r.tagged
          result.failed += r.failed
        } catch (e) {
          // 网络、HTTP 错误、限流：整轮中止并退避，不计失败次数（不是这些条目的错）
          result.error = (e as Error).message
          blockedUntil = clock() + ERROR_BACKOFF_MS
          if (!(e instanceof LlmError)) logger.warn("enrich tag failed", e)
          else logger.warn(`enrich tag：${result.error}（${ERROR_BACKOFF_MS / 60_000} 分钟内不再调用）`)
          return result
        }
      }
    }
    return result
  }

  return {
    /** 跑一轮；已有一轮在跑就返回那一轮的结果（单飞）。 */
    run(maxBatches = deps.maxBatchesPerRun ?? DEFAULT_MAX_BATCHES_PER_RUN): Promise<TagRunResult> {
      running ??= runOnce(maxBatches).finally(() => {
        running = undefined
      })
      return running
    },
    /** 一直跑到没有待标注的（或模型接口出错）：给 enrich:tag 脚本追积压用。 */
    async drain(onProgress?: (total: TagRunResult) => void): Promise<TagRunResult> {
      const total: TagRunResult = { calls: 0, tagged: 0, failed: 0 }
      for (;;) {
        const r = await runOnce(10)
        total.calls += r.calls
        total.tagged += r.tagged
        total.failed += r.failed
        onProgress?.(total)
        if (r.error) return { ...total, error: r.error }
        if (r.calls === 0) return total
        // 整轮一条都没标成：再跑也是一样的结果（失败次数会涨到上限后退出），继续循环即可，由 MAX_TAG_ATTEMPTS 兜底
      }
    },
  }
}

export type Tagger = ReturnType<typeof createTagger>

/** 批量标注的来源范围：ENRICH_TAG_CATEGORIES（逗号分隔的分类，不分大小写；默认 finance,财经；`*` = 不限）。 */
export function readTagCategories(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env.ENRICH_TAG_CATEGORIES?.trim()
  if (raw === "*") return null
  return (raw ? raw.split(",") : ["finance", "财经"]).map(s => s.trim().toLowerCase()).filter(Boolean)
}
