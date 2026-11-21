import process from "node:process"
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
 * - ready：连上后第一条，{ latestSeq }。
 * - item：一条新条目（FeedItemView），SSE 的 id 就是它的 seq。默认（与 GET /api/feed 一致）同一事件的转载不单独推：
 *   后到的成员推 merge；带 expand=1 时成员也推 item。
 * - merge：某个已有的组来了新成员，{ seq（成员的）, groupId（主条目的 seq）, sourceId, sourcesCount（现在的来源数） }；SSE 的 id 是成员的 seq。
 *   前端把 groupId 那一行的来源数改成 sourcesCount 即可，主条目的位置与内容不变。
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
  | { type: "ready", latestSeq: number }
  | { type: "item", item: FeedItemView }
  | { type: "merge", seq: number, groupId: number, sourceId: string, sourcesCount: number }
  | { type: "reset", latestSeq: number }

export interface StreamDeps {
  store: Pick<ObservationStore, "onIngest">
  feed: Pick<FeedStore, "latestSeq" | "after" | "groups">
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

  const deliver = (items: IngestedItem[]) => {
    chain = chain.then(async () => {
      if (closed) return
      const descs = await deps.describe()
      const match = streamMatcher(params, descs)
      const byId = new Map(descs.map(d => [d.id, d]))
      const fresh = [...items].sort((a, b) => a.seq - b.seq).filter(item => item.seq > lastSent)
      // 一批一次读出这些条目所在组的来源数与成员
      const groups = fresh.length ? await deps.feed.groups(fresh.map(i => i.dupOf ?? i.seq)) : new Map()
      for (const item of fresh) {
        if (closed || item.seq <= lastSent) continue
        lastSent = item.seq
        if (!match(item)) continue
        const group = groups.get(item.dupOf ?? item.seq)
        if (item.dupOf !== null && !params.expand) {
          emit({ type: "merge", seq: item.seq, groupId: item.dupOf, sourceId: item.sourceId, sourcesCount: group?.sourcesCount ?? 1 })
        } else {
          emit({ type: "item", item: toView(item, byId, group) })
        }
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
    emit({ type: "ready", latestSeq: head })
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
    // 排空缓冲的过程中又来的批次仍进缓冲（replaying 还是 true），一直排到空、同步关掉 replaying：
    // 否则排空时到达的批次会直接 deliver，排在还没轮到的缓冲批次前面，后者的 seq 小于 lastSent 被丢掉
    while (buffer.length) await deliver(buffer.shift()!)
    replaying = false
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

/**
 * 同时在线的 SSE 连接数上限（FEED_MAX_STREAMS 覆盖）。待定：没有实测依据，只是不让连接无限涨——每个连接都挂一个入库监听器
 * 并在每批新条目上读一次注册表；本机使用者（几个面板 + 几个 agent）远用不到 32。要按实测调（跟进项，见 #2186 评论）。
 */
export const DEFAULT_MAX_STREAMS = 32

export function maxStreams(env: Record<string, string | undefined> = process.env) {
  const n = Number(env.FEED_MAX_STREAMS)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_STREAMS
}
