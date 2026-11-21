import { createDatabase } from "db0"
import sqlite from "db0/connectors/better-sqlite3"
import { ObservationStore } from "#/collector/store"

/** 内存 SQLite 里的观测库，每个测试一份。 */
export async function memoryStore() {
  const db = createDatabase(sqlite({ name: ":memory:" }))
  const store = new ObservationStore(db)
  await store.init()
  return { db, store }
}

export async function selectAll<T = Record<string, any>>(db: ReturnType<typeof createDatabase>, sql: string, ...params: any[]) {
  return await db.prepare(sql).all(...params) as T[]
}
