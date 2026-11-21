import { guarded } from "#/registry/http"
import { getSourceService } from "#/registry/service-runtime"

/**
 * 保存一个用户源：{ name, category?, interval?, enabled?, slug?, spec }。
 * spec 通常来自 POST /api/collector/sources/preview 确认过的结果。下一轮采集（至多一分钟内）开始抓。
 */
export default defineEventHandler(event => guarded(event, async () => {
  const body = await readBody(event)
  const created = await (await getSourceService()).create(body)
  setResponseStatus(event, 201)
  return created
}))
