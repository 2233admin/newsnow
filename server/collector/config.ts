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
   * 依据（实测，2026-11-21，2 核沙箱）：52 个源同时到期的整轮（进程刚启动、以及 30 分钟档与 10 分钟档重合时）
   * 在 8 路并发下约 19 秒抓完（日志 9:38:00→9:38:19、10:08:00→10:08:19），单轮远小于 1 分钟的 tick。
   * 瓶颈在网络等待不在算力；上限是对源站的礼貌与对本机的保守值，不是由测量推出的最优值，仍标待定。
   */
  concurrency: number
  /**
   * observations 保留天数，items 永久。
   * 待定。实测（2026-11-21，本沙箱连续跑 32 分钟，52 个源）：9065 行 observations + 2142 行 items 共占 2.6 MB，
   * 约 288 字节/条观测（含 items 与主键索引）；外推约 41 万行/天（含启动那一轮全量，稳态略低；各源每次返回 8–200 条，多数 20–50）。
   * 7 天约 280 万行、约 0.8 GB；14 天翻倍。取 7 天是因为热榜名次历史主要看近期；体积吃紧时调小。
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
