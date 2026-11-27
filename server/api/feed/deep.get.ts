import { getFeed } from "#/feed/runtime"
import { guarded } from "#/registry/http"

/**
 * 按需深读（#2188 补充）：GET /api/feed/deep?seq=123。第一次调模型读这条新闻并缓存进库，之后直接读缓存。
 * 返回 { seq, status: "ok" | "unavailable" | "error", cached, deep, basis, model, createdAt, message? }：
 * - ok：deep = { summary, keyPoints, entities, caveats }；basis 说明依据（page 读了原文页面、title 只有标题与同组其他报道的标题）。
 * - unavailable：没配模型（不是故障）。error：模型出错或返回解析不出来，没有缓存，可以重试。
 * seq 不存在 404。访问控制同 GET /api/feed（只给本机或带令牌）。
 */
export default defineEventHandler(event => guarded(event, async () => (await getFeed()).service.deep(getQuery(event).seq)))
