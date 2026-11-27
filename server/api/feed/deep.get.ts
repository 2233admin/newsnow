import { callerOf } from "#/actions/http"
import { getActions } from "#/actions/runtime"
import { getFeed } from "#/feed/runtime"
import { guarded } from "#/registry/http"

/**
 * 按需深读（#2188 补充）：GET /api/feed/deep?seq=123。第一次调模型读这条新闻并缓存进库，之后直接读缓存。
 * 返回 { seq, status: "ok" | "unavailable" | "error", cached, deep, basis, model, createdAt, message? }：
 * - ok：deep = { summary, keyPoints, entities, caveats }；basis 说明依据（page 读了原文页面、title 只有标题与同组其他报道的标题）。
 *   deep 里的文字来自外部网页，经过模型转述：展示端一律按纯文本渲染，不要当 HTML / Markdown。
 * - unavailable：没配模型（不是故障）。error：模型出错或返回解析不出来，没有缓存；30 秒内同一条再请求直接返回这次的失败（不重抓不重调），之后可以重试。
 * seq 不存在 404。全局并发（默认 4）或每分钟未命中缓存的次数（默认 20）到上限回 429，带 Retry-After；缓存命中不受限。
 * 真的调了模型的读写一条审计（action = deep.read，不可撤销）。访问控制同 GET /api/feed（只给本机或带令牌）。
 */
export default defineEventHandler(event => guarded(event, async () => {
  const [{ service }, actions] = await Promise.all([getFeed(), getActions()])
  const caller = callerOf(event)
  return service.deep(getQuery(event).seq, { onCall: async (call) => {
    await actions.recordDeep(caller, call)
  } })
}))
