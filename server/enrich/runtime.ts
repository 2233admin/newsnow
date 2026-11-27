import process from "node:process"
import { createDeepReader } from "./deep"
import type { DeepReader } from "./deep"
import { EnrichStore } from "./store"
import { createLlm, readDeepLlm, readTagLlm } from "./llm"
import { createTagger, readTagCategories } from "./tagger"
import type { Tagger } from "./tagger"
import { readNetPolicy, safeFetchText } from "#/registry/net"
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
      fetchPage: process.env.ENRICH_DEEP_FETCH_PAGE === "false" ? undefined : url => safeFetchText(url, policy),
    })
    return { tagger, deep, capabilities: { tagging: !!tagLlm, deep: !!deepLlm } }
  })().catch((e) => {
    promise = undefined
    throw e
  })
  return promise
}
