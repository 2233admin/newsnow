import { guarded } from "#/registry/http"
import { InputError } from "#/registry/spec"
import { getPresetService } from "#/registry/preset-runtime"

/** 启用 / 停用一个预置源：{ "enabled": true | false }。启用后下一轮采集（至多一分钟内）开始抓。 */
export default defineEventHandler(event => guarded(event, async () => {
  const body = await readBody(event)
  if (typeof body?.enabled !== "boolean") throw new InputError("请求体需要 { \"enabled\": true | false }")
  const presets = await getPresetService()
  const slug = getRouterParam(event, "slug") ?? ""
  return body.enabled ? await presets.enable(slug) : await presets.disable(slug)
}))
