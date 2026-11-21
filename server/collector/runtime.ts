import process from "node:process"
import { createCollector } from "./collect"
import { readCollectorConfig } from "./config"
import { ObservationStore } from "./store"
import { createEnricher } from "#/enrich/enrich"
import { getRegistry } from "#/registry/runtime"

/**
 * 运行时装配（Nitro 的 task 与 API 共用）：库来自 Nitro 的 useDatabase()，
 * 即 nitro.config.ts 里配的 better-sqlite3 / bun-sqlite / Cloudflare D1，与 server/database/cache.ts 同一个库。
 * 表只在每个进程里建一次；INIT_TABLE=false 时不建（同 cache.ts，给不允许运行时建表的部署用）。
 */
let storePromise: Promise<ObservationStore> | undefined

export function getObservationStore() {
  storePromise ??= (async () => {
    const db = useDatabase()
    const store = new ObservationStore(db)
    if (process.env.INIT_TABLE !== "false") await store.init()
    // 写库时同步富化（标题清洗、标的识别、去重分组，#2188）；ENRICH_ENABLED=false 关掉，条目留 enriched = 0，以后可回填
    if (process.env.ENRICH_ENABLED !== "false") store.setEnricher(createEnricher(db))
    return store
  })().catch((e) => {
    storePromise = undefined
    throw e
  })
  return storePromise
}

let collector: ReturnType<typeof createCollector> | undefined

export async function getCollector() {
  const store = await getObservationStore()
  // 每一轮从运行时注册表取源：内置 + 已启用的用户源（#2185）
  const registry = await getRegistry()
  collector ??= createCollector({ store, resolve: () => registry.snapshot(), config: readCollectorConfig(process.env) })
  return collector
}
