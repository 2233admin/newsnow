import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { ObservationStore } from "#/collector/store"
import { UserSourceStore } from "#/registry/store"
import type { FetchText } from "#/registry/adapters"
import { NET_DEFAULTS } from "#/registry/net"
import type { NetPolicy } from "#/registry/net"
import { createSourceService } from "#/registry/service"

export function RSS(items: [string, string][], title = "Example Feed") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${title}</title><link>https://example.com/</link><description>d</description>
${items.map(([t, l]) => `<item><title>${t}</title><link>${l}</link><guid>${l}</guid><pubDate>Fri, 21 Nov 2026 10:00:00 GMT</pubDate></item>`).join("\n")}
</channel></rss>`
}

export const FEED_ITEMS: [string, string][] = Array.from({ length: 8 }, (_, i) => [`新闻 ${i}`, `https://example.com/p/${i}`])

export const policy = (over: Partial<NetPolicy> = {}): NetPolicy => ({ allowPrivate: false, ...NET_DEFAULTS, ...over })

/** 内存库里的观测库 + 用户源库；fetchText 用 pages 里写好的页面，没写的当 404。 */
export async function setupWorld(pages: Record<string, string> = {}) {
  const db = createDatabase(sqlite({ name: ":memory:" }))
  const observations = new ObservationStore(db)
  await observations.init()
  const store = new UserSourceStore(db)
  await store.init()
  const calls: string[] = []
  const fetchText: FetchText = async (url) => {
    calls.push(url)
    if (url in pages) return pages[url]
    throw new Error(`HTTP 404 ${url}`)
  }
  let now = Date.UTC(2026, 10, 21, 12, 0, 0)
  const service = createSourceService({ store, observations, fetchText, policy: policy(), resolver: async () => ["93.184.216.34"], clock: () => now })
  return { db, observations, store, fetchText, calls, pages, service, advance: (ms: number) => {
    now += ms
  } }
}
