import type { Database } from "db0"
import type { UserSourceConfig, UserSourceSpec } from "./spec"

/**
 * 用户源配置表（#2185）。放在与观测库同一个库里，但 source_id 的命名空间分开：
 * 观测库里用户源的 source_id 是 `user:<slug>`，这里的主键是不带前缀的 slug。
 *
 * SQL 一律参数化，只用 SQLite 与 D1 共有的语法。每条语句参数个数固定（≤ 9），远低于 D1 的 100 个上限。
 */

export interface StoredUserSource extends UserSourceConfig {
  createdAt: number
  updatedAt: number
}

function rowsOf<T>(res: unknown): T[] {
  const rows = (res as { results?: unknown })?.results ?? res
  return Array.isArray(rows) ? rows as T[] : []
}

function fromRow(r: Record<string, any>): StoredUserSource | undefined {
  let spec: UserSourceSpec
  try {
    spec = JSON.parse(r.spec)
  } catch {
    return undefined
  }
  return {
    slug: r.slug,
    name: r.name,
    category: r.category,
    interval: r.interval_ms,
    enabled: r.enabled === 1,
    spec,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export class UserSourceStore {
  constructor(private db: Database) {}

  async init() {
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS user_sources (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        spec TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `).run()
  }

  /** 全部用户源，按创建顺序；配置损坏（spec 不是合法 JSON）的行跳过，不让一行坏数据拖垮整轮采集。 */
  async list(): Promise<StoredUserSource[]> {
    const rows = rowsOf<Record<string, any>>(await this.db.prepare(`
      SELECT slug, name, category, interval_ms, enabled, spec, created_at, updated_at
      FROM user_sources ORDER BY created_at, slug
    `).all())
    return rows.map(fromRow).filter((s): s is StoredUserSource => !!s)
  }

  async get(slug: string): Promise<StoredUserSource | undefined> {
    const row = await this.db.prepare(`
      SELECT slug, name, category, interval_ms, enabled, spec, created_at, updated_at
      FROM user_sources WHERE slug = ?
    `).get(slug) as Record<string, any> | undefined
    return row ? fromRow(row) : undefined
  }

  /** 新增；slug 已存在返回 false（主键冲突不抛错，调用方换名字重试）。 */
  async insert(config: UserSourceConfig, now: number): Promise<boolean> {
    const res = await this.db.prepare(`
      INSERT OR IGNORE INTO user_sources (slug, name, category, interval_ms, enabled, spec, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(config.slug, config.name, config.category, config.interval, config.enabled ? 1 : 0, JSON.stringify(config.spec), now, now)
    return changesOf(res) > 0
  }

  async update(config: UserSourceConfig, now: number): Promise<boolean> {
    const res = await this.db.prepare(`
      UPDATE user_sources
      SET name = ?, category = ?, interval_ms = ?, enabled = ?, spec = ?, updated_at = ?
      WHERE slug = ?
    `).run(config.name, config.category, config.interval, config.enabled ? 1 : 0, JSON.stringify(config.spec), now, config.slug)
    return changesOf(res) > 0
  }

  async delete(slug: string): Promise<boolean> {
    const res = await this.db.prepare(`DELETE FROM user_sources WHERE slug = ?`).run(slug)
    return changesOf(res) > 0
  }
}

/** better-sqlite3 经 db0 返回 { changes }，D1 返回 { meta: { changes } }（https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/ ）。 */
function changesOf(res: unknown): number {
  const r = res as { changes?: number, meta?: { changes?: number }, success?: boolean } | undefined
  return r?.changes ?? r?.meta?.changes ?? (r?.success ? 1 : 0)
}
