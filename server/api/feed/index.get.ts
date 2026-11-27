import { getFeed } from "#/feed/runtime"
import { guarded } from "#/registry/http"

/**
 * 信息流查询（#2186）：新闻大面板、个股面板、晨报、白板、agent 读同一个接口。只给本机，规则同用户源接口（registry/http.ts）：
 * 条目里有 user:* 的订阅内容，不对外。
 *
 * 参数（都可省）：
 *   from / to      排序时间范围，毫秒或日期串；from 含、to 不含
 *   since          入库时间 ≥ since 的（拉新；含端点，客户端按 seq 去重）
 *   source         来源 id，逗号分隔或重复；`user:*` 这种带 * 的是前缀
 *   category       分类，逗号分隔或重复
 *   q              关键词，空白分隔，原始标题或清洗后的标题须包含每一个词
 *   symbol         标的，品种 id「代码.场所」（600519.XSHG、AAPL.XNAS、BTCUSDT.BINANCE），逗号分隔或重复；
 *                  条目或它所在组的任一成员带其中之一就命中
 *   expand=1       同一事件的多条报道每条单独出现；默认聚成一组、每组一行（带 sourcesCount 与 members）：先按 source / category / includeInactive 筛，再在范围里收拢，
 *                  代表行是范围内最早的那条（主条目在范围外时是范围里最早的成员，groupId 仍是主条目的 seq）；范围 = 来源 / 分类 / 停用 + q + from / to（since 与 cursor 一样是位置条件，不进范围）；标的按组判断
 *   market         cn / us / crypto：只要按这个市场对齐过交易日的条目（#2188 补充）
 *                  给了 symbol 与交易日条件（tradeDate / tradeDateFrom / tradeDateTo）却没给 market 时，由标的的场所推出市场（600519.XSHG → cn、AAPL.XNAS → us、BTCUSDT.BINANCE → crypto）；
 *                  symbol 跨了多个市场又没给 market 是 400。K 线上点（交易日，标的）不必自己带 market，也不会取到另一个市场的交易日凑巧相同的新闻
 *   tradeDate      交易日 YYYY-MM-DD：条目在某个市场里对齐到这一天（给了 market 就限定在那个市场）。收盘后与休市日的新闻对齐到下一个交易日
 *   tradeDateFrom / tradeDateTo  交易日区间（含端点），口径同 tradeDate（按对齐的交易日，不是 from / to 那样按发布时间戳），与 market 配合。
 *                  同一组的成员落在不同交易日时，区间查询里这一组只出一行（区间内最早的成员）；要按天各出一行、或要每天的条数，用 GET /api/feed/days
 *   impact         影响类型（分类表里的名称，见 GET /api/feed/meta），逗号分隔或重复；组的标注命中其中之一。标注挂在主条目上，按组判断
 *   direction      positive / negative / neutral，逗号分隔或重复；对这条新闻本身的读法（正面 / 负面 / 中性），不是涨跌预测
 *   includeFiltered=1  含规则层过滤掉的（荐股软文、榜单水文、广告、行情罗列），每条带 filterReason；默认不含
 *   limit          每页条数，1–200，默认 50
 *   cursor         上一页响应的 nextCursor
 *   includeInactive=1  含停用与已删除的源的历史条目
 * 每条另带 align（对齐交易日）、tags（影响类型 / 方向 / 一句话要点 / 题材，没标过是 null）、filterReason，形状见 server/feed/service.ts 的 FeedItemView。
 * 排序：feedTs 倒序，同一毫秒按 sourceId、itemId 倒序（见 server/feed/store.ts）。
 */
export default defineEventHandler(event => guarded(event, async () => (await getFeed()).service.query(getQuery(event))))
