/**
 * 采集器配置，全部来自环境变量（Nitro 的 task 与脚本共用）。
 *
 * 数字的依据都在各字段旁；标「待定」的是没有实测数据时的保守估计，
 * 等本机连续跑一轮后按 `pnpm collector:check` 的输出调（见 PR 说明）。
 */
export interface CollectorConfig {
  /** COLLECT_ENABLED=false 关掉采集；默认开 */
  enabled: boolean
  /**
   * 同时在抓的源数上限。
   * 待定：46 个适配器、interval 分 2/5/10/30/60 分钟五档（shared/sources.json 实数：2 分 8 个、5 分 7 个、10 分 33 个含 14 个 redirect 重复项），
   * 同一分钟最多十几个源同时到期；源站各不相同，瓶颈在网络等待不在算力，2 核机器上 8 路是保守值。
   */
  concurrency: number
  /**
   * observations 保留天数，items 永久。
   * 待定：按 shared/sources.json 的 52 个非 redirect 源、每源约 30 条、各按自己的 interval 算，约 29 万行/天；
   * 每行约 200–300 字节（item_id 常是整条 URL，主键索引再占一份），7 天约 2 百万行、400–600 MB。
   * 7 天够看热榜的名次变化，体积 SQLite 能扛；14 天会翻倍。本机跑出实际行数与文件体积后再调。
   */
  retentionDays: number
  /**
   * 单个源一次最多记多少条。
   * 待定：上游 /api/s 对外只给 30 条，这里放宽到 200 只是防御异常源返回海量条目，不是业务上限。
   */
  maxItemsPerSource: number
  /**
   * 单个源整次抓取的总超时。
   * 依据：myFetch 单次请求超时 10 秒、失败重试 3 次（server/utils/fetch.ts），最坏约 40 秒；多请求的适配器（如 cls）再留余量。待定。
   */
  sourceTimeoutMs: number
  /** COLLECT_SOURCES=jin10,hackernews 只采这几个源（逗号分隔）；不设则采全部 */
  only?: string[]
}

export const COLLECTOR_DEFAULTS = {
  concurrency: 8,
  retentionDays: 7,
  maxItemsPerSource: 200,
  sourceTimeoutMs: 60_000,
} as const

function positiveInt(raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === "") return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export function readCollectorConfig(env: Record<string, string | undefined>): CollectorConfig {
  const only = env.COLLECT_SOURCES?.split(",").map(s => s.trim()).filter(Boolean)
  return {
    enabled: env.COLLECT_ENABLED !== "false",
    concurrency: positiveInt(env.COLLECT_CONCURRENCY, COLLECTOR_DEFAULTS.concurrency),
    retentionDays: positiveInt(env.COLLECT_RETENTION_DAYS, COLLECTOR_DEFAULTS.retentionDays),
    maxItemsPerSource: positiveInt(env.COLLECT_MAX_ITEMS, COLLECTOR_DEFAULTS.maxItemsPerSource),
    sourceTimeoutMs: positiveInt(env.COLLECT_TIMEOUT_MS, COLLECTOR_DEFAULTS.sourceTimeoutMs),
    only: only?.length ? only : undefined,
  }
}
