import process from "node:process"
import { createDeepReader } from "./deep"
import type { DeepReader } from "./deep"
import { EnrichStore } from "./store"
import { createLlm, readDeepLlm, readTagLlm } from "./llm"
import { createTagger, readTagCategories } from "./tagger"
import type { Tagger } from "./tagger"
import { readNetPolicy, safeFetchText } from "#/registry/net"
import type { NetPolicy } from "#/registry/net"
import { getRegistry } from "#/registry/runtime"

/**
 * 分类标注与深读的运行时装配（#2188 补充）：模型配置来自环境变量（见 llm.ts），没配就是 null，调用方跳过这一层。
 * 库同 collector/runtime.ts：Nitro 的 useDatabase()；表由 ObservationStore.init() 建。
 */
export interface EnrichRuntime {
  /** 批量标注；没配模型是 null */
  tagger: Tagger | null
  /** 按需深读（总是有；没配模型时返回 unavailable） */
  deep: DeepReader
  capabilities: { tagging: boolean, deep: boolean }
}

/**
 * 深读抓原文的网络策略：固定不放行内网，与 USER_SOURCES_ALLOW_PRIVATE 无关。
 * 那个开关是给「用户亲自填的订阅地址」（自建 RSSHub、内网 JSON 服务）放行的；深读抓的是条目里的链接，来自任意第三方 feed，
 * 开关打开后若沿用，一个恶意 feed 把条目链接设成内网地址、再被点深读，内网页面正文就会交给模型、摘要回到响应里（SSRF 出口）。
 */
/** 深读抓的原文页面至多这么多字节（超了当抓取失败、退回只用标题）。待定：新闻正文页 HTML 一般几十到几百 KB，取 1 MiB；比订阅源的 5 MiB 小，因为只取正文前 6000 字。 */
export const DEEP_PAGE_MAX_BYTES = 1024 * 1024
export const deepFetchPolicy = (policy: NetPolicy): NetPolicy => ({ ...policy, allowPrivate: false, maxBytes: Math.min(policy.maxBytes, DEEP_PAGE_MAX_BYTES) })

const positiveInt = (v: string | undefined) => Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined

let promise: Promise<EnrichRuntime> | undefined

export function getEnrichRuntime(): Promise<EnrichRuntime> {
  promise ??= (async () => {
    const store = new EnrichStore(useDatabase())
    const tagLlm = readTagLlm()
    const deepLlm = readDeepLlm()
    const categories = readTagCategories()
    const policy = readNetPolicy(process.env)
    const registry = await getRegistry()
    const tagger = tagLlm
      ? createTagger({
          store,
          llm: createLlm(tagLlm),
          sourceIds: async () => categories === null ? null : (await registry.describe()).filter(d => categories.includes(d.category.toLowerCase())).map(d => d.id),
          maxBatchesPerRun: Number.isInteger(Number(process.env.ENRICH_TAG_MAX_BATCHES)) && Number(process.env.ENRICH_TAG_MAX_BATCHES) > 0 ? Number(process.env.ENRICH_TAG_MAX_BATCHES) : undefined,
        })
      : null
    const deep = createDeepReader({
      store,
      llm: deepLlm ? createLlm(deepLlm) : null,
      model: deepLlm?.model ?? null,
      fetchPage: process.env.ENRICH_DEEP_FETCH_PAGE === "false" ? undefined : url => safeFetchText(url, deepFetchPolicy(policy)),
      maxConcurrent: positiveInt(process.env.ENRICH_DEEP_MAX_CONCURRENT),
      maxPerMinute: positiveInt(process.env.ENRICH_DEEP_MAX_PER_MINUTE),
    })
    return { tagger, deep, capabilities: { tagging: !!tagLlm, deep: !!deepLlm } }
  })().catch((e) => {
    promise = undefined
    throw e
  })
  return promise
}
