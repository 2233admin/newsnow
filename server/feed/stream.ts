import type { FeedParams } from "./params"
import { streamMatcher, toView } from "./service"
import type { FeedItemView } from "./service"
import type { FeedStore } from "./store"
import type { SourceDescriptor } from "#/registry/registry"
import type { IngestedItem, ObservationStore } from "#/collector/store"

/**
 * 实时推送（#2186）：新条目入库时由采集器的写库处（ObservationStore.onIngest）直接推过来，不轮询库。
 *
 * 事件（SSE 的 event 名）：
 * - ready：连上后第一条，{ latestSeq, unimplemented? }。
 * - item：一条新条目（FeedItemView），SSE 的 id 就是它的 seq。
 * - reset：客户端落后太多（或 Last-Event-ID 比库里最大的 seq 还大，库被换过），不补发了：
 *   请重新 GET /api/feed 取首屏，再用响应里的 latestSeq 当 Last-Event-ID 重连。{ latestSeq }。
 * - ping：保活，id 是流已处理到的 seq（带了筛选时，没匹配的条目也会推进它，重连不必重扫）。
 *
 * 断线重连：客户端带 Last-Event-ID（浏览器的 EventSource 自动带；首次连接用 ?lastEventId=）。
 * 先订阅（缓冲）再从库里补发 seq > Last-Event-ID 的，补完再放行缓冲里的，按 seq 去重：补发与实时之间没有缝。
 * 补发读的是库，不依赖内存缓冲，所以进程重启后也能续上。
 */

/**
 * 最多补发多少条，更落后的发 reset。待定：没有按客户端实测推出。
 * 参照：2026-11-21 本沙箱连续跑 32 分钟、52 个源共入库 2142 条（含启动那一轮的全量），稳态每分钟入库几十条以内；
 * 1000 条约相当于离线半小时到一两小时，再久让客户端重拉首屏比一次补发几千条更合理。
 */
export const REPLAY_MAX = 1000
const REPLAY_BATCH = 500
/** 保活间隔。待定：常见反向代理的空闲断开多在 30–60 秒，取一半以内。 */
export const PING_INTERVAL_MS = 20_000

export type StreamEvent =
  | { type: "ready", latestSeq: number, unimplemented?: string[] }
  | { type: "item", item: FeedItemView }
  | { type: "reset", latestSeq: number }

export interface StreamDeps {
  store: Pick<ObservationStore, "onIngest">
  feed: Pick<FeedStore, "latestSeq" | "after">
  describe: () => Promise<SourceDescriptor[]>
}

export interface FeedStreamHandle {
  /** 补发完成（之后都是实时） */
  ready: Promise<void>
  /** 流已处理到的 seq */
  watermark: () => number
  close: () => void
}

export function openFeedStream(deps: StreamDeps, params: FeedParams, lastEventId: number | undefined, emit: (e: StreamEvent) => void): FeedStreamHandle {
  let closed = false
  let replaying = true
  let lastSent = 0
  const buffer: IngestedItem[][] = []
  let chain: Promise<unknown> = Promise.resolve()
  const symbolOnly = params.symbol.length > 0 // 标的筛选未实装：什么都不推

  const deliver = (items: IngestedItem[]) => {
    chain = chain.then(async () => {
      if (closed) return
      const descs = await deps.describe()
      const match = symbolOnly ? () => false : streamMatcher(params, descs)
      const byId = new Map(descs.map(d => [d.id, d]))
      for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
        if (closed || item.seq <= lastSent) continue
        lastSent = item.seq
        if (match(item)) emit({ type: "item", item: toView(item, byId) })
      }
    }).catch((e) => {
      logger.warn("feed stream delivery failed", e)
    })
    return chain
  }

  const unsubscribe = deps.store.onIngest((items) => {
    if (replaying) buffer.push(items)
    else void deliver(items)
  })

  const ready = (async () => {
    const head = await deps.feed.latestSeq()
    lastSent = lastEventId ?? head
    emit({ type: "ready", latestSeq: head, ...(symbolOnly ? { unimplemented: ["symbol"] } : {}) })
    if (lastEventId !== undefined && (lastEventId > head || head - lastEventId > REPLAY_MAX)) {
      lastSent = head
      emit({ type: "reset", latestSeq: head })
    } else if (lastEventId !== undefined) {
      for (;;) {
        const rows = await deps.feed.after(lastSent, REPLAY_BATCH)
        if (closed || !rows.length) break
        await deliver(rows)
        if (rows.length < REPLAY_BATCH) break
      }
    }
    replaying = false
    for (const items of buffer.splice(0)) await deliver(items)
  })()

  return {
    ready,
    watermark: () => lastSent,
    close() {
      closed = true
      unsubscribe()
    },
  }
}
