import { callerOf } from "#/actions/http"
import { getActions } from "#/actions/runtime"
import { guarded } from "#/registry/http"

/** 部分更新：name / category / interval / enabled / spec，给哪项改哪项。enabled=false 即停用。经动作层：写审计，可撤销。 */
export default defineEventHandler(event => guarded(event, async () => {
  const { value, auditId } = await (await getActions()).updateSource(callerOf(event), getRouterParam(event, "slug") ?? "", await readBody(event))
  return { ...value, auditId }
}))
