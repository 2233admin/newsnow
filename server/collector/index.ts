import process from "node:process"
import type { SourceID } from "@shared/types"
import type { CollectorSource } from "./scheduler"
import { ObservationStore } from "./store"
import { getters } from "#/getters"

let storePromise: Promise<ObservationStore> | undefined

/** 观测库，建表只做一次。 */
export function getObservationStore(): Promise<ObservationStore> {
  storePromise ??= (async () => {
    const store = new ObservationStore(useDatabase())
    if (process.env.INIT_TABLE !== "false") await store.init()
    return store
  })()
  // 建表失败下次再试，不把失败的 Promise 留着。
  storePromise.catch(() => {
    storePromise = undefined
  })
  return storePromise
}

/** 要采集的源：有抓取函数、没停用、不是转向别的源的。 */
export function collectorSources(): CollectorSource[] {
  return (Object.keys(getters) as SourceID[])
    .filter(id => sources[id] && !sources[id].redirect && !sources[id].disable)
    .map(id => ({ id, interval: sources[id].interval, fetch: getters[id] }))
}
