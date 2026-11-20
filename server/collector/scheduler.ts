import type { NewsItem } from "@shared/types"
import type { ObservationStore } from "./store"

/**
 * 定时采集：不等有人请求，按每个源自己的刷新间隔去抓，结果交给观测库。
 * 间隔沿用上游 shared/pre-sources.ts 里每个源的 interval（快讯 2 分钟、热榜 10 分钟、慢的 30 到 60 分钟）。
 */

export interface CollectorSource {
  id: string
  /** 刷新间隔，毫秒。 */
  interval: number
  fetch: () => Promise<NewsItem[]>
}

export interface CollectorOptions {
  store: ObservationStore
  sources: CollectorSource[]
  now?: () => number
  /** 同时抓几个源。 */
  concurrency?: number
  onError?: (source: string, error: unknown) => void
}

export interface RoundResult {
  attempted: string[]
  succeeded: string[]
  failed: string[]
  added: number
}

/**
 * 最短间隔。上游有个只给测试用的 1 毫秒间隔；真跑起来不能比这更勤，免得把来源打爆。
 * 一分钟是主循环的节拍，比它更短的间隔本来也排不上。
 */
export const MIN_INTERVAL = 60 * 1000

/** 同时抓的源数。来源各不相同，并发只为不让一个慢的源卡住全部；4 是随手取的，没有实测依据，待 #2184 量过再调。 */
export const DEFAULT_CONCURRENCY = 4

/** 到点该抓的源：从没抓过的，或者距上次开始抓已经过了它的间隔的。 */
export function dueSources(sources: CollectorSource[], lastRun: ReadonlyMap<string, number>, now: number): CollectorSource[] {
  return sources.filter((source) => {
    const last = lastRun.get(source.id)
    if (last === undefined) return true
    return now - last >= Math.max(source.interval, MIN_INTERVAL)
  })
}

export class Collector {
  private store
  private sources
  private now
  private concurrency
  private onError
  private lastRun = new Map<string, number>()
  private running = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(options: CollectorOptions) {
    this.store = options.store
    this.sources = options.sources
    this.now = options.now ?? (() => Date.now())
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
    this.onError = options.onError
  }

  /** 抓一轮到点的源。一个源失败不影响别的源。上一轮没跑完时这一轮跳过。 */
  async runOnce(): Promise<RoundResult> {
    const result: RoundResult = { attempted: [], succeeded: [], failed: [], added: 0 }
    if (this.running) return result
    this.running = true
    try {
      const queue = dueSources(this.sources, this.lastRun, this.now())
      const worker = async () => {
        for (let source = queue.shift(); source; source = queue.shift()) {
          const startedAt = this.now()
          // 失败也记开始时间：坏掉的源照它自己的间隔重试，不每一拍都打。
          this.lastRun.set(source.id, startedAt)
          result.attempted.push(source.id)
          try {
            const items = await source.fetch()
            result.added += await this.store.record(source.id, items, startedAt)
            await this.store.recordSuccess(source.id, items.length, startedAt)
            result.succeeded.push(source.id)
          } catch (error) {
            result.failed.push(source.id)
            this.onError?.(source.id, error)
            try {
              await this.store.recordFailure(source.id, error instanceof Error ? error.message : String(error), startedAt)
            } catch (storeError) {
              this.onError?.(source.id, storeError)
            }
          }
        }
      }
      await Promise.all(Array.from({ length: this.concurrency }, worker))
    } finally {
      this.running = false
    }
    return result
  }

  /** 开始定时采集：马上抓一轮，之后每个节拍看一次有哪些源到点。 */
  start(tick = MIN_INTERVAL) {
    if (this.timer) return
    void this.runOnce()
    this.timer = setInterval(() => void this.runOnce(), tick)
    // 不让定时器拦着进程退出。
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
