import type { NewsItem, Source } from "@shared/types"
import type { CollectorConfig } from "./config"
import type { ObservationStore } from "./store"
import { toObservedRows } from "./store"

export type SourceGetters = Record<string, (() => Promise<NewsItem[]>) | undefined>
export type SourceMetas = Record<string, Pick<Source, "interval" | "redirect">>

/**
 * 判定「到期」时允许的提前量。
 * 依据：调度每分钟 tick 一次（nitro.config.ts 的 scheduledTasks），cron 在整秒触发，抖动远小于 10 秒；
 * 没有提前量的话，间隔 2 分钟的源会因为 tick 偏早几毫秒而被推迟到第 3 分钟才抓。
 * 10 秒远小于最小的 interval（2 分钟）与 tick 周期（1 分钟）。
 */
export const DUE_TOLERANCE_MS = 10_000

/**
 * 清理过期观测的最小间隔。依据：保留期以天计，每小时清一次每次只删约 1/24 天的量（按 config.ts 的估算约一万行），
 * 单次 DELETE 很短；每个 tick（1 分钟）都清则是白白多扫一遍索引。
 */
export const PURGE_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface TickFailure {
  sourceId: string
  error: string
}

export interface TickSummary {
  startedAt: number
  /** 本 tick 参与调度的源数（已排除 redirect 与没有适配器的） */
  scheduled: number
  /** 本 tick 到期、实际去抓的源 */
  due: string[]
  succeeded: string[]
  failed: TickFailure[]
  /** 本 tick 清理了 observed_at 早于它的观测；没到清理时间则没有 */
  purgedBefore?: number
}

/**
 * 要采集的源：有适配器、不是 redirect（redirect 是同一个源的别名，抓了会重复入库），
 * 有 only 时再按它过滤。
 */
export function collectableSourceIds(sources: SourceMetas, getters: SourceGetters, only?: string[]) {
  return Object.keys(sources).filter(id =>
    !sources[id].redirect && typeof getters[id] === "function" && (!only || only.includes(id)),
  )
}

export function isDue(lastAttemptAt: number | null | undefined, interval: number, now: number) {
  if (lastAttemptAt === null || lastAttemptAt === undefined) return true
  return now - lastAttemptAt >= interval - DUE_TOLERANCE_MS
}

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
  })
  return Promise.race([Promise.resolve().then(run), timeout]).finally(() => clearTimeout(timer))
}

async function mapLimit<T>(list: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const item = list[next++]
      await fn(item)
    }
  })
  await Promise.all(workers)
}

export interface CollectorDeps {
  store: ObservationStore
  getters: SourceGetters
  sources: SourceMetas
  config: CollectorConfig
  /** 测试里注入；默认 Date.now */
  clock?: () => number
  log?: { info: (...args: any[]) => void, warn: (...args: any[]) => void }
}

export function createCollector(deps: CollectorDeps) {
  const { store, getters, sources, config } = deps
  const clock = deps.clock ?? Date.now
  const log = deps.log ?? logger
  let running: Promise<TickSummary> | undefined
  let lastPurgeAt: number | undefined

  async function collectOne(sourceId: string, attemptAt: number): Promise<TickFailure | undefined> {
    try {
      const raw = await withTimeout(() => getters[sourceId]!(), config.sourceTimeoutMs)
      const rows = toObservedRows(Array.isArray(raw) ? raw : [], config.maxItemsPerSource)
      // 空结果按失败记：这些站点的适配器遇到改版或被拦时往往返回空列表而不是抛错
      if (!rows.length) throw new Error("empty result")
      await store.recordObservations(sourceId, rows, clock())
      await store.recordSuccess(sourceId, attemptAt, rows.length)
      return undefined
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      // 记失败本身再出错（库不可用）也不能影响其他源
      await store.recordFailure(sourceId, attemptAt, e).catch(err => log.warn(`record failure of ${sourceId} failed`, err))
      return { sourceId, error }
    }
  }

  async function run(): Promise<TickSummary> {
    const startedAt = clock()
    const ids = collectableSourceIds(sources, getters, config.only)
    const health = new Map((await store.getHealth()).map(h => [h.sourceId, h]))
    const due = ids
      .filter(id => isDue(health.get(id)?.lastAttemptAt, sources[id].interval, startedAt))
      // 最久没抓的先抓
      .sort((a, b) => (health.get(a)?.lastAttemptAt ?? 0) - (health.get(b)?.lastAttemptAt ?? 0))

    const failed: TickFailure[] = []
    const succeeded: string[] = []
    await mapLimit(due, config.concurrency, async (id) => {
      const failure = await collectOne(id, startedAt)
      if (failure) failed.push(failure)
      else succeeded.push(id)
    })
    let purgedBefore: number | undefined
    if (lastPurgeAt === undefined || startedAt - lastPurgeAt >= PURGE_INTERVAL_MS) {
      const cutoff = startedAt - config.retentionDays * DAY_MS
      try {
        await store.purgeObservations(cutoff)
        lastPurgeAt = startedAt
        purgedBefore = cutoff
      } catch (e) {
        log.warn("purge observations failed", e)
      }
    }
    if (due.length) log.info(`collect: ${due.length} due of ${ids.length}, ${succeeded.length} ok, ${failed.length} failed`)
    return { startedAt, scheduled: ids.length, due, succeeded, failed, purgedBefore }
  }

  return {
    /** 跑一轮：只抓到期的源。上一轮还没结束时返回同一个 promise，不叠跑。 */
    tick(): Promise<TickSummary> {
      running ??= run().finally(() => {
        running = undefined
      })
      return running
    },
  }
}
