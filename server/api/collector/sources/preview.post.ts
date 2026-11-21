import { guarded } from "#/registry/http"
import { getSourceService } from "#/registry/service-runtime"

/**
 * 预览，不保存：{ url }（自动识别 RSS / JSON / 网页里声明的 RSS，/路由 与 rsshub://路由 按 RSSHub）
 * 或 { spec }（试手写的 JSON 映射与选择器规则）。返回识别出的 spec、建议名称与前 5 条。
 */
export default defineEventHandler(event => guarded(event, async () => (await getSourceService()).preview(await readBody(event))))
