import process from "node:process"
import { getObservationStore } from "#/collector/runtime"
import { readCollectorConfig } from "#/collector/config"
import { getHealthReport } from "#/collector/health"
import { getters } from "#/getters"

/**
 * 采集健康（只读）：每个源最近成功时间、连续失败次数、最近错误。
 * 注意错误信息里可能带上游地址；对公网开放的部署请自行在反向代理层限制。
 */
export default defineEventHandler(async () => {
  const config = readCollectorConfig(process.env)
  const store = await getObservationStore()
  return {
    enabled: config.enabled,
    now: Date.now(),
    sources: await getHealthReport(store, sources, getters, config.only),
  }
})
