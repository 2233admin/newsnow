import { guarded } from "#/registry/http"
import { MAX_OPML_BYTES } from "#/registry/opml"
import { getSourceService } from "#/registry/service-runtime"

/**
 * 导入 OPML：请求体就是 OPML 文本（Content-Type 随意），或 JSON { opml }。
 * ?onConflict=replace：slug 已存在时用文件里的覆盖；默认 skip 保留现有。
 */
export default defineEventHandler(event => guarded(event, async () => {
  const declared = Number(getRequestHeader(event, "content-length"))
  if (Number.isFinite(declared) && declared > MAX_OPML_BYTES) throw createError({ statusCode: 413, message: `OPML 超过 ${MAX_OPML_BYTES} 字节` })
  let xml = (await readRawBody(event, "utf8")) ?? ""
  if (getRequestHeader(event, "content-type")?.includes("json")) {
    try {
      xml = String(JSON.parse(xml).opml ?? "")
    } catch {
      throw createError({ statusCode: 400, message: "JSON 请求体需要 { opml: \"…\" }" })
    }
  }
  const { onConflict } = getQuery(event)
  return (await getSourceService()).importOpml(xml, onConflict === "replace" ? "replace" : "skip")
}))
