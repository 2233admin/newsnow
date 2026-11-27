import * as cheerio from "cheerio"
import { logger } from "../utils/logger"
import type { IngestedItem } from "../collector/store"
import { LlmError } from "./llm"
import type { LlmCall } from "./llm"
import type { EnrichStore } from "./store"
import { extractObjects } from "./tagger"

/**
 * 按需深读层（#2188 补充）：用户点开一条新闻（或 agent 按 seq 调工具）时才调用模型，结果存进 item_deep，第二次直接读缓存。
 * 结构参照 owengetinfo-design/PokieTicker 的 backend/pipeline/layer2.py（MIT License，Copyright (c) 2025 PokieTicker）：
 * 先查缓存、没有再调模型、解析 JSON、INSERT OR REPLACE 缓存。与它不同的地方：
 * - 它让模型分析「对 X 股价的涨跌原因」，这里不做涨跌预测，只读这条新闻说了什么、涉及谁、哪些信息缺失；
 * - 它只有标题和摘要；这里还会尽力抓原文页面（走和用户订阅源同一套 SSRF 防护的抓取，抓不到就退回只用标题与同组其他报道的标题），
 *   并把依据记在结果里（basis = page | title），调用方能知道这份深读是读了原文、还是只扩写了标题；
 * - 并发点同一条只调一次模型（单飞）；模型出错或解析不出来不写缓存，下次还能重试。
 * 缓存何时算命中（独立审 M4）：version 等于 DEEP_VERSION（提示词 / 字段改了就加一，老缓存作废）、标题指纹对得上（retitle 之后失效）、
 * 并且——依据是原文（page）的永远有效；依据只是标题（title）而这条有链接、也配了抓取时，只在 TITLE_BASIS_RETRY_MS 之内有效，
 * 过了再试一次抓原文（抓原文失败多是超时、限流之类的临时问题，不该把降级结果永久固化）。重试时模型出错就仍给旧结果。
 * 没配模型时返回 status = unavailable，不报错、不造假。
 */

export interface DeepRead {
  /** 这条新闻说了什么，2–4 句 */
  summary: string
  /** 要点，至多 6 条 */
  keyPoints: string[]
  /** 提到的公司、机构、人物、标的、行业 */
  entities: string[]
  /** 材料里没有、读者该自己核实的点（来源不明、数字缺失、只有标题等） */
  caveats: string[]
}

export type DeepStatus = "ok" | "unavailable" | "error"

export interface DeepResponse {
  seq: number
  status: DeepStatus
  /** 命中了缓存（没调模型） */
  cached: boolean
  deep: DeepRead | null
  /** 依据：page = 抓到了原文页面；title = 只有标题与同组其他报道的标题 */
  basis: "page" | "title" | null
  model: string | null
  createdAt: number | null
  /** status 不是 ok 时的原因 */
  message?: string
}

/** 深读缓存的提示词 / 字段版本：改了 buildDeepPrompt 或结果字段就加一，老缓存不再命中。 */
export const DEEP_VERSION = 1
/**
 * 依据只是标题的缓存，这么久之后可以重试抓原文。待定：没有实测依据；取 15 分钟是想让「超时、限流」这类临时失败至少隔一个常见的限流窗口再试，
 * 同时一条新闻最多每 15 分钟多花一次模型调用（抓不到原文的永久情形——付费墙、纯脚本页——每次重试仍是 title，代价就是这一次调用）。
 */
export const TITLE_BASIS_RETRY_MS = 15 * 60_000

/** 标题指纹（cyrb53，53 位，十六进制）：只用来判断「标题变了没有」，不是安全哈希。 */
export function titleFingerprint(title: string): string {
  let h1 = 0xDEADBEEF
  let h2 = 0x41C6CE57
  for (let i = 0; i < title.length; i++) {
    const c = title.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

/** 喂给模型的原文最多这么多字。待定：按常见财经长稿 3000–5000 字、模型上下文足够取的。 */
export const MAX_PAGE_CHARS = 6000
const MAX_MEMBER_TITLES = 10
export const DEEP_MAX_OUTPUT_TOKENS = 1500

/** 从 HTML 里取正文文字：去掉脚本样式导航，取 article 或全部段落。 */
export function extractPageText(html: string, max = MAX_PAGE_CHARS): string {
  const $ = cheerio.load(html)
  $("script,style,noscript,nav,header,footer,aside,form,iframe,svg").remove()
  const root = $("article").length ? $("article").first() : $("body")
  const paras = root.find("p").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get().filter(t => t.length >= 20)
  const text = (paras.length ? paras.join("\n") : root.text().replace(/\s+/g, " ").trim())
  return text.slice(0, max)
}

export function buildDeepPrompt(item: IngestedItem, memberTitles: string[], pageText: string | null): { system: string, user: string } {
  const system = "你是财经新闻的细读助手。只依据给出的材料回答，材料里没有的信息不要补充、不要猜；缺什么就写进 caveats。不要做任何涨跌预测，不给买卖建议。只输出 JSON，不要解释，不要代码块。"
  const parts = [`标题：${(item.cleanTitle ?? item.title).slice(0, 300)}`]
  if (memberTitles.length) parts.push(`同一事件的其他报道标题：\n${memberTitles.map(t => `- ${t.slice(0, 200)}`).join("\n")}`)
  if (item.symbols.length) parts.push(`识别出的标的：${item.symbols.join("、")}`)
  parts.push(pageText ? `原文（可能被截断）：\n${pageText}` : "原文：没有抓到，只有标题。")
  const user = `${parts.join("\n\n")}

按下面的格式返回一个 JSON 对象：
{"summary":"这条新闻说了什么，2–4 句","keyPoints":["要点，至多 6 条"],"entities":["提到的公司、机构、人物、标的、行业"],"caveats":["材料里没有、读者该自己核实的点"]}
JSON：`
  return { system, user }
}

const strings = (v: unknown, max: number) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(x => x.trim()).filter(Boolean).slice(0, max) : []

/** 解析深读结果；summary 缺失（模型没按格式答）返回 null，不凑数。 */
export function parseDeepResponse(text: string): DeepRead | null {
  for (const o of extractObjects(text)) {
    if (typeof o.summary === "string" && o.summary.trim()) {
      return { summary: o.summary.trim(), keyPoints: strings(o.keyPoints, 6), entities: strings(o.entities, 20), caveats: strings(o.caveats, 6) }
    }
  }
  return null
}

export interface DeepDeps {
  store: EnrichStore
  /** 没配模型是 null */
  llm: LlmCall | null
  model: string | null
  /** 抓原文页面（带 SSRF 防护）；不给就不抓，只用标题 */
  fetchPage?: (url: string) => Promise<string>
  clock?: () => number
}

/** 找不到这条新闻。 */
export class DeepNotFound extends Error {}

export function createDeepReader(deps: DeepDeps) {
  const { store } = deps
  const clock = deps.clock ?? Date.now
  const inflight = new Map<number, Promise<DeepResponse>>()

  const unavailable = (seq: number, message: string): DeepResponse => ({ seq, status: "unavailable", cached: false, deep: null, basis: null, model: null, createdAt: null, message })

  async function compute(seq: number): Promise<DeepResponse> {
    const item = await store.item(seq)
    if (!item) throw new DeepNotFound(`没有 seq = ${seq} 的新闻`)
    const fingerprint = titleFingerprint(item.cleanTitle ?? item.title)
    const url = item.origUrl ?? item.url
    const canFetch = !!(url && deps.fetchPage)

    // 命中缓存：版本、标题指纹都对得上；依据只是标题且还能再试（有链接、配了抓取、配了模型）的，过了重试间隔就当没命中
    let stale: DeepResponse | undefined
    const cached = await store.getDeep(seq)
    if (cached && cached.version === DEEP_VERSION && cached.titleHash === fingerprint) {
      try {
        const deep = JSON.parse(cached.result) as DeepRead
        const hit: DeepResponse = { seq, status: "ok", cached: true, deep, basis: cached.basis === "page" ? "page" : "title", model: cached.model, createdAt: cached.createdAt }
        const retriable = hit.basis === "title" && canFetch && !!deps.llm
        if (!retriable || clock() - cached.createdAt < TITLE_BASIS_RETRY_MS) return hit
        stale = hit
      } catch {
        // 缓存里的 JSON 坏了：当作没有，重新读
      }
    }
    if (!deps.llm || !deps.model) return stale ?? unavailable(seq, "没有配置模型：设置 ENRICH_LLM_PROVIDER、ENRICH_LLM_API_KEY、ENRICH_LLM_MODEL（或 ENRICH_DEEP_LLM_*）后可用")

    const members = await store.groups([item.dupOf ?? item.seq])
    const info = members.get(item.dupOf ?? item.seq)
    const memberTitles = await titlesOf(store, [info?.main, ...(info?.members ?? [])].flatMap(m => m && m.seq !== seq ? [m.seq] : []).slice(0, MAX_MEMBER_TITLES))

    let pageText: string | null = null
    if (url && deps.fetchPage) {
      try {
        const text = extractPageText(await deps.fetchPage(url))
        // 太短多半是跳转页、验证页或纯脚本页，不当原文
        if (text.length >= 200) pageText = text
      } catch (e) {
        logger.debug(`enrich deep：抓原文失败（${(e as Error).message}），只用标题`)
      }
    }

    const { system, user } = buildDeepPrompt(item, memberTitles, pageText)
    let text: string
    try {
      text = await deps.llm({ system, user, maxTokens: DEEP_MAX_OUTPUT_TOKENS })
    } catch (e) {
      if (!(e instanceof LlmError)) logger.warn("enrich deep failed", e)
      // 重试时模型出错：旧的降级结果还能用，不拿错误换掉它
      return stale ?? { ...unavailable(seq, (e as Error).message), status: "error" }
    }
    const deep = parseDeepResponse(text)
    if (!deep) return stale ?? { ...unavailable(seq, "模型返回的内容解析不出来（没有 summary），没有缓存，可以重试"), status: "error" }
    const basis = pageText ? "page" : "title"
    const createdAt = clock()
    await store.saveDeep({ seq, result: JSON.stringify(deep), model: deps.model, basis, createdAt, version: DEEP_VERSION, titleHash: fingerprint })
    return { seq, status: "ok", cached: false, deep, basis, model: deps.model, createdAt }
  }

  return {
    /** 读一条的深读：缓存命中直接返回；同一条并发只调一次模型。条目不存在抛 DeepNotFound。 */
    read(seq: number): Promise<DeepResponse> {
      let p = inflight.get(seq)
      if (!p) {
        p = compute(seq).finally(() => inflight.delete(seq))
        inflight.set(seq, p)
      }
      return p
    },
  }
}

export type DeepReader = ReturnType<typeof createDeepReader>

async function titlesOf(store: EnrichStore, seqs: number[]): Promise<string[]> {
  const out: string[] = []
  for (const seq of seqs) {
    const it = await store.item(seq)
    if (it) out.push(it.cleanTitle ?? it.title)
  }
  return out
}
