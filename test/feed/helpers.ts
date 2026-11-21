import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { ObservationStore } from "#/collector/store"
import type { ObservedRow } from "#/collector/store"
import { createFeedService } from "#/feed/service"
import { FeedStore } from "#/feed/store"
import type { SourceDescriptor } from "#/registry/registry"

export const T0 = Date.UTC(2026, 10, 21, 0, 0, 0)

export function row(itemId: string, over: Partial<ObservedRow> = {}): ObservedRow {
  return {
    itemId,
    title: `标题 ${itemId}`,
    url: `https://example.com/${itemId}`,
    pubDate: null,
    rank: 1,
    extra: null,
    ...over,
  }
}

export function descriptors(over: SourceDescriptor[] = []): SourceDescriptor[] {
  return [
    { id: "jin10", name: "金十数据", category: "finance", builtin: true, enabled: true },
    { id: "hackernews", name: "Hacker News", category: "tech", builtin: true, enabled: true },
    { id: "weibo", name: "微博 实时热搜", category: "china", builtin: true, enabled: true },
    { id: "user:a", name: "用户源 a", category: "mine", builtin: false, enabled: true },
    { id: "user:b", name: "用户源 b", category: "mine", builtin: false, enabled: true },
    ...over,
  ]
}

/** 内存库里的观测库 + 信息流查询；descs 可在测试里改。 */
export async function feedWorld(descs: SourceDescriptor[] = descriptors()) {
  const db = createDatabase(sqlite({ name: ":memory:" }))
  const store = new ObservationStore(db)
  await store.init()
  const feedStore = new FeedStore(db)
  const state = { descs }
  const service = createFeedService({ store: feedStore, describe: async () => state.descs, clock: () => T0 + 1000 })
  return { db, store, feedStore, service, state }
}

/** 一次采集落库：sourceId 的这些条目在 observedAt 时刻被看到。 */
export async function ingest(w: { store: ObservationStore }, sourceId: string, rows: ObservedRow[], observedAt: number) {
  return await w.store.recordObservations(sourceId, rows, observedAt)
}

/** 翻完整个流（按游标），返回每一页。 */
export async function pageAll(service: { query: (p: Record<string, unknown>) => Promise<any> }, params: Record<string, unknown> = {}, onPage?: (i: number) => Promise<void>) {
  const pages: any[] = []
  let cursor: string | undefined
  for (let i = 0; i < 10_000; i++) {
    const page = await service.query({ ...params, cursor })
    pages.push(page)
    if (onPage) await onPage(i)
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  return pages
}

export const keyOf = (i: { sourceId: string, itemId: string }) => `${i.sourceId}/${i.itemId}`
