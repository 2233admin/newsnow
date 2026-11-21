import { guarded } from "#/registry/http"
import { getPresetService } from "#/registry/preset-runtime"

/**
 * 预置订阅包的 OPML 版本（全部 katana:enabled="false"）：给别的阅读器用，
 * 也可以经 POST /api/collector/sources/opml 导入成「停用」的用户源。
 */
export default defineEventHandler(event => guarded(event, async () => {
  const xml = (await getPresetService()).opml()
  setResponseHeader(event, "Content-Type", "text/x-opml; charset=utf-8")
  setResponseHeader(event, "Content-Disposition", "attachment; filename=\"newsnow-presets.opml\"")
  return xml
}))
