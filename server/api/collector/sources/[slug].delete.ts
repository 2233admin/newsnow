import { callerOf } from "#/actions/http"
import { getActions } from "#/actions/runtime"
import { guarded } from "#/registry/http"

/** 删除配置；已入库的条目与观测保留。经动作层：写审计，可撤销（撤销会把配置原样加回来）。 */
export default defineEventHandler(event => guarded(event, async () => {
  const { auditId } = await (await getActions()).removeSource(callerOf(event), getRouterParam(event, "slug") ?? "")
  return { ok: true, auditId }
}))
