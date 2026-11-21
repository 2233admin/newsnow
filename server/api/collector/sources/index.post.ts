import { callerOf } from "#/actions/http"
import { getActions } from "#/actions/runtime"
import { guarded } from "#/registry/http"

/**
 * 保存一个用户源：{ name, category?, interval?, enabled?, slug?, spec }。
 * spec 通常来自 POST /api/collector/sources/preview 确认过的结果。下一轮采集（至多一分钟内）开始抓。
 * 经动作层：写审计，响应里的 auditId 可交给 POST /api/collector/audit/:id/undo 撤销。
 */
export default defineEventHandler(event => guarded(event, async () => {
  const body = await readBody(event)
  const { value, auditId } = await (await getActions()).addSource(callerOf(event), body)
  setResponseStatus(event, 201)
  return { ...value, auditId }
}))
