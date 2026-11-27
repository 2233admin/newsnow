import { getFeed } from "#/feed/runtime"
import { guarded } from "#/registry/http"

/**
 * 按交易日聚合（独立审 M6，给 #2189 的 K 线打点与区间归因用）：GET /api/feed/days?market=cn&symbol=600519.XSHG&tradeDateFrom=2026-11-01&tradeDateTo=2026-11-30
 *
 * 返回 { market, tradeDateFrom, tradeDateTo, days: [{ tradeDate, count, byImpact, byDirection, untagged }], now }：区间（含端点）内每个有新闻的交易日一项，升序。
 * - market：cn / us / crypto；不给时由 symbol 的场所推出（跨市场的 symbol 要自己带 market）。tradeDate 单日也行（等于 from = to = 它）；区间最长 800 天。
 * - 其余筛选同 GET /api/feed：symbol、source、category、q、impact、direction、theme、includeFiltered、expand……（limit、cursor、since 不看）。
 * - count 与「GET /api/feed 带同样参数加 tradeDate = 这一天」返回的总条数一致（默认每组一行；expand=1 时每条一行），同一套过滤与收拢规则，测试里逐日对过。
 * - byImpact / byDirection：组的标注分布，只数有标注的；untagged 是还没有标注的条数（没配模型、排队中、失败放弃），所以 count = untagged + 有标注的条数。
 * 访问控制同 GET /api/feed。
 */
export default defineEventHandler(event => guarded(event, async () => (await getFeed()).service.days(getQuery(event))))
