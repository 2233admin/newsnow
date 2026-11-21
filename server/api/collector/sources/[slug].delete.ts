import { guarded } from "#/registry/http"
import { getSourceService } from "#/registry/service-runtime"

/** 删除配置；已入库的条目与观测保留。 */
export default defineEventHandler(event => guarded(event, async () => {
  await (await getSourceService()).remove(getRouterParam(event, "slug") ?? "")
  return { ok: true }
}))
