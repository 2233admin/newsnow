import { guarded } from "#/registry/http"
import { getSourceService } from "#/registry/service-runtime"

/** 用户源列表（含各自的采集健康）。只给本机，见 registry/http.ts。 */
export default defineEventHandler(event => guarded(event, async () => ({
  sources: await (await getSourceService()).list(),
})))
