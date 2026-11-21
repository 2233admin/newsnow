import { guarded } from "#/registry/http"
import { getSourceService } from "#/registry/service-runtime"

/** 导出 OPML（含停用的源）。格式见 registry/opml.ts。 */
export default defineEventHandler(event => guarded(event, async () => {
  const xml = await (await getSourceService()).exportOpml()
  setResponseHeader(event, "Content-Type", "text/x-opml; charset=utf-8")
  setResponseHeader(event, "Content-Disposition", "attachment; filename=\"newsnow-sources.opml\"")
  return xml
}))
