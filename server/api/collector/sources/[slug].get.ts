import { guarded } from "#/registry/http"
import { getSourceService } from "#/registry/service-runtime"

export default defineEventHandler(event => guarded(event, async () => (await getSourceService()).get(getRouterParam(event, "slug") ?? "")))
