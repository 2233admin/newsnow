import type { Database } from "db0"
import type { UserSourceConfig } from "#/registry/spec"

/**
 * 审计记录（#2186）：动作层每做一次改动写一行。放在与观测库同一个库里。
 *
 * - 谁：entry 是入口（http / mcp），actor 是调用方自报的名字（HTTP 的 X-Actor 头，MCP 同样；可空）。
 *   不是身份认证：入口已经由 checkAccess 限定为本机或持令牌者，actor 只用来在审计里区分是哪个 agent 或哪个页面。
 * - 改了什么：changes 是一组 { slug, before, after }（before 为 null = 新增，after 为 null = 删除）；
 *   一次导入可以有多项，撤销时整组一起回滚。
 * - 撤销：撤销本身也是一行（action = audit.undo，undoOf 指向被撤销的那行），被撤销的那行记下 undoneBy；
 *   撤销一条撤销记录 = 重做，会把原来那行的 undoneBy 清掉。
 *
 * SQL 一律参数化，每条语句的参数个数固定（≤ 8）。
 */

/** 一个用户源在某一时刻的配置（不含 slug 与时间戳；用来比对与还原）。 */
export type SourceSnapshot = Omit<UserSourceConfig, "slug">

export interface SourceChange {
  slug: string
  before: SourceSnapshot | null
  after: SourceSnapshot | null
}

export type AuditEntry = "http" | "mcp"

export interface AuditRecord {
  id: number
  at: number
  entry: AuditEntry
  actor: string | null
  action: string
  summary: string
  changes: SourceChange[]
  undoOf: number | null
  undoneBy: number | null
}

export type NewAudit = Omit<AuditRecord, "id" | "undoneBy">

function rowsOf<T>(res: unknown): T[] {
  const rows = (res as { results?: unknown })?.results ?? res
  return Array.isArray(rows) ? rows as T[] : []
}

function fromRow(r: Record<string, any>): AuditRecord {
  let changes: SourceChange[] = []
  try {
    changes = JSON.parse(r.changes)
  } catch {}
  return {
    id: r.id,
    at: r.at,
    entry: r.entry,
    actor: r.actor,
    action: r.action,
    summary: r.summary,
    changes,
    undoOf: r.undo_of,
    undoneBy: r.undone_by,
  }
}

const COLUMNS = `id, at, entry, actor, action, summary, changes, undo_of, undone_by`

export class AuditStore {
  constructor(private db: Database) {}

  async init() {
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        entry TEXT NOT NULL,
        actor TEXT,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        changes TEXT NOT NULL,
        undo_of INTEGER,
        undone_by INTEGER
      )
    `).run()
  }

  async append(rec: NewAudit): Promise<AuditRecord> {
    const res = await this.db.prepare(`
      INSERT INTO audit_log (at, entry, actor, action, summary, changes, undo_of)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING ${COLUMNS}
    `).all(rec.at, rec.entry, rec.actor, rec.action, rec.summary, JSON.stringify(rec.changes), rec.undoOf)
    return fromRow(rowsOf<Record<string, any>>(res)[0])
  }

  async get(id: number): Promise<AuditRecord | undefined> {
    const row = await this.db.prepare(`SELECT ${COLUMNS} FROM audit_log WHERE id = ?`).get(id) as Record<string, any> | undefined
    return row ? fromRow(row) : undefined
  }

  /** 最新的在前；before 是上一页最后一条的 id。 */
  async list(limit: number, before?: number): Promise<AuditRecord[]> {
    const rows = before === undefined
      ? await this.db.prepare(`SELECT ${COLUMNS} FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit)
      : await this.db.prepare(`SELECT ${COLUMNS} FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?`).all(before, limit)
    return rowsOf<Record<string, any>>(rows).map(fromRow)
  }

  async setUndoneBy(id: number, undoneBy: number | null) {
    await this.db.prepare(`UPDATE audit_log SET undone_by = ? WHERE id = ?`).run(undoneBy, id)
  }
}
