import { FEED_ITEMS, RSS, setupWorld } from "../registry/helpers"
import { createActions } from "#/actions/actions"
import { AuditStore } from "#/actions/audit"

export const FEED = "https://feed.example/rss"
export const OTHER = "https://other.example/rss"

export async function actionsWorld() {
  const w = await setupWorld({ [FEED]: RSS(FEED_ITEMS), [OTHER]: RSS(FEED_ITEMS) })
  const audit = new AuditStore(w.db)
  await audit.init()
  let now = Date.UTC(2026, 10, 21, 12, 0, 0)
  const actions = createActions({ store: w.store, service: w.service, audit, clock: () => now++ })
  return { ...w, audit, actions }
}

export const http = { entry: "http" as const }
export const mcp = (actor?: string) => ({ entry: "mcp" as const, actor })

export const rssBody = (over: Record<string, unknown> = {}) => ({ name: "示例", slug: "example", interval: 120_000, spec: { kind: "rss", url: FEED }, ...over })
