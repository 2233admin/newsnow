import { createFeedService } from "./service"
import { FeedStore } from "./store"
import { getObservationStore } from "#/collector/runtime"
import { getRegistry } from "#/registry/runtime"

/** 与观测库同一个 useDatabase()；items 表由 ObservationStore.init() 建（INIT_TABLE 的约定同 collector/runtime.ts）。 */
let promise: ReturnType<typeof build> | undefined
async function build() {
  await getObservationStore()
  const registry = await getRegistry()
  const store = new FeedStore(useDatabase())
  return { store, service: createFeedService({ store, describe: () => registry.describe() }), describe: () => registry.describe() }
}

export function getFeed() {
  promise ??= build().catch((e) => {
    promise = undefined
    throw e
  })
  return promise
}
