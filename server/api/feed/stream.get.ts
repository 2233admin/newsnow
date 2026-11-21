import { getObservationStore } from "#/collector/runtime"
import { getFeed } from "#/feed/runtime"
import { normalizeFeedParams } from "#/feed/params"
import { PING_INTERVAL_MS, openFeedStream } from "#/feed/stream"
import { guarded } from "#/registry/http"

/**
 * 实时推送（SSE）。事件与重连规则见 server/feed/stream.ts 的文件头。
 * 筛选参数同 GET /api/feed 里对实时流有意义的：source、category、q、symbol、includeInactive。
 * Last-Event-ID：请求头（EventSource 重连时自动带），或 ?lastEventId=（首次连接，用 GET /api/feed 响应里的 latestSeq）。
 * 不给就只推连上之后入库的新条目。只给本机；浏览器 EventSource 不能带 Authorization，用 USER_SOURCES_TOKEN 的调用方请用 fetch 读流。
 */
export default defineEventHandler(event => guarded(event, async () => {
  const query = getQuery(event)
  const params = normalizeFeedParams(query)
  const rawId = getHeader(event, "last-event-id") ?? (typeof query.lastEventId === "string" ? query.lastEventId : undefined)
  const lastEventId = rawId && /^\d{1,15}$/.test(rawId.trim()) ? Number(rawId.trim()) : undefined

  const feed = await getFeed()
  const eventStream = createEventStream(event)
  const stream = openFeedStream({ store: await getObservationStore(), feed: feed.store, describe: feed.describe }, params, lastEventId, (e) => {
    if (e.type === "item") void eventStream.push({ id: String(e.item.seq), event: "item", data: JSON.stringify(e.item) })
    else void eventStream.push({ event: e.type, data: JSON.stringify(e) })
  })
  const timer = setInterval(() => {
    void eventStream.push({ id: String(stream.watermark()), event: "ping", data: String(Date.now()) })
  }, PING_INTERVAL_MS)
  stream.ready.catch((e) => {
    logger.warn("feed stream setup failed", e)
    void eventStream.close()
  })
  eventStream.onClosed(() => {
    clearInterval(timer)
    stream.close()
  })
  return eventStream.send()
}))
