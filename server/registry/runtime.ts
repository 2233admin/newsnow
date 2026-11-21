import process from "node:process"
import { sources } from "@shared/sources"
import { readNetPolicy, safeFetchText } from "./net"
import { createRegistry } from "./registry"
import { UserSourceStore } from "./store"
import { getters } from "#/getters"

/**
 * 运行时装配（Nitro 的 task 与 API 共用）：与观测库同一个 useDatabase()。
 * INIT_TABLE=false 时不建表（同 collector/runtime.ts）。
 */
let storePromise: Promise<UserSourceStore> | undefined

export function getUserSourceStore() {
  storePromise ??= (async () => {
    const store = new UserSourceStore(useDatabase())
    if (process.env.INIT_TABLE !== "false") await store.init()
    return store
  })().catch((e) => {
    storePromise = undefined
    throw e
  })
  return storePromise
}

/** 出网策略来自环境变量（USER_SOURCES_ALLOW_PRIVATE 等），改了重启进程即可，不用重新构建。 */
export const fetchText = (url: string) => safeFetchText(url, readNetPolicy(process.env))

let registryPromise: ReturnType<typeof build> | undefined
async function build() {
  return createRegistry({
    builtinSources: sources,
    builtinGetters: getters,
    store: await getUserSourceStore(),
    fetchText,
  })
}

export function getRegistry() {
  registryPromise ??= build().catch((e) => {
    registryPromise = undefined
    throw e
  })
  return registryPromise
}
