import { getObservationStore } from "#/collector"

/** 每个源最近一次采集的情况：最近成功、最近失败、连续失败次数。 */
export default defineEventHandler(async () => {
  const store = await getObservationStore()
  return { sources: await store.health() }
})
