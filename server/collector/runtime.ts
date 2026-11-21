import process from "node:process"
import { createCollector } from "./collect"
import { readCollectorConfig } from "./config"
import { ObservationStore } from "./store"
import { getRegistry } from "#/registry/runtime"

/**
 * 运行时装配（Nitro 的 task 与 API 共用）：库来自 Nitro 的 useDatabase()，
 * 即 nitro.config.ts 里配的 better-sqlite3 / bun-sqlite / Cloudflare D1，与 server/database/cache.ts 同一个库。
 * 表只在每个进程里建一次；INIT_TABLE=false 时不建（同 cache.ts，给不允许运行时建表的部署用）。
 */
let storePromise: Promise<ObservationStore> | undefined

export function getObservationStore() {
  storePromise ??= (async () => {
    const store = new ObservationStore(useDatabase())
    if (process.env.INIT_TABLE !== "false") await store.init()
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
