import { getFeed } from "#/feed/runtime"
import { guarded } from "#/registry/http"

/** 筛选与展示用的枚举（#2188 补充）：各市场的影响类型分类表、方向、时段、过滤原因，以及标注与深读的模型有没有配。 */
export default defineEventHandler(event => guarded(event, async () => (await getFeed()).service.meta()))
