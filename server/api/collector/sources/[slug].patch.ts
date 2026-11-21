import { guarded } from "#/registry/http"
import { getSourceService } from "#/registry/service-runtime"

/** 部分更新：name / category / interval / enabled / spec，给哪项改哪项。enabled=false 即停用。 */
export default defineEventHandler(event => guarded(event, async () => (await getSourceService()).update(getRouterParam(event, "slug") ?? "", await readBody(event))))
