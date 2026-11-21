import { guarded } from "#/registry/http"
import { MAX_OPML_BYTES } from "#/registry/opml"
import { getSourceService } from "#/registry/service-runtime"

/**
 * 导入 OPML：请求体是 JSON `{ "opml": "<OPML 文本>" }`（Content-Type: application/json，由 registry/http.ts 的访问检查强制；
 * 不收裸 XML，否则跨站页面能用 text/plain 的简单请求绕过预检）。
 * ?onConflict=replace：slug 已存在时用文件里的覆盖；默认 skip 保留现有。
 */
export default defineEventHandler(event => guarded(event, async () => {
  const declared = Number(getRequestHeader(event, "content-length"))
  if (Number.isFinite(declared) && declared > MAX_OPML_BYTES) throw createError({ statusCode: 413, message: `OPML 超过 ${MAX_OPML_BYTES} 字节` })
  const body = await readBody(event)
  if (typeof body?.opml !== "string") throw createError({ statusCode: 400, message: "请求体需要 { \"opml\": \"…\" }" })
  const { onConflict } = getQuery(event)
  return (await getSourceService()).importOpml(body.opml, onConflict === "replace" ? "replace" : "skip")
}))
