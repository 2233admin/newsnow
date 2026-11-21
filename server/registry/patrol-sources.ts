import type { Database } from "db0"
import { UserSourceStore } from "./store"
import { toSourceId } from "./spec"
import type { PatrolSourceMeta } from "#/collector/patrol"

/**
 * 命令行脚本（巡检、采集自检）要覆盖的「已启用的用户源」（#2187）：
 * 只读 user_sources 表，只取 enabled 的，键是 `user:<slug>`，与观测库、source_health 里的 source_id 对得上。
 * 停用的源不在其中：它不再被采集，source_health 里残留的旧记录不该被当成故障。
 * 库里还没有 user_sources 表（没起过服务，或没有用过用户源）就返回空，不建表、不改库。
 * 内置源 id 里没有冒号，用户源一律 `user:` 开头（registry.ts 保证），合并时不会互相覆盖。
 */
export async function readEnabledUserSources(db: Database): Promise<Record<string, PatrolSourceMeta>> {
  const table = await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'user_sources'").get()
  if (!table) return {}
  const out: Record<string, PatrolSourceMeta> = {}
  for (const s of await new UserSourceStore(db).list()) {
    if (s.enabled) out[toSourceId(s.slug)] = { name: s.name, interval: s.interval }
  }
  return out
}
