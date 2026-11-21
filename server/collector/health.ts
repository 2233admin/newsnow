import type { CollectorConfig } from "./config"
import type { HealthRecord, ObservationStore } from "./store"
import type { SourceGetters, SourceMetas } from "./collect"
import { collectableSourceIds } from "./collect"

/**
 * pending：还没抓过；ok：最近一次成功；failing：最近一次失败（连续失败次数见 consecutiveFailures）。
 */
export type HealthStatus = "pending" | "ok" | "failing"

export interface SourceHealthReport extends HealthRecord {
  interval: number
  status: HealthStatus
}

/** 每个会被采集的源一行，没抓过的也在列表里（status 为 pending），方便一眼看出谁没有数据。 */
export async function getHealthReport(
  store: ObservationStore,
  sources: SourceMetas,
  getters: SourceGetters,
  only?: CollectorConfig["only"],
): Promise<SourceHealthReport[]> {
  const rows = new Map((await store.getHealth()).map(h => [h.sourceId, h]))
  return collectableSourceIds(sources, getters, only).map((sourceId) => {
    const row = rows.get(sourceId) ?? {
      sourceId,
      lastAttemptAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorAt: null,
      lastItemCount: null,
    }
    const status: HealthStatus = row.lastAttemptAt === null ? "pending" : row.consecutiveFailures > 0 ? "failing" : "ok"
    return { ...row, interval: sources[sourceId].interval, status }
  })
}
