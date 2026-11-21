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
 *   limit          每页条数，1–200，默认 50
 *   cursor         上一页响应的 nextCursor
 *   includeInactive=1  含停用与已删除的源的历史条目
 * 排序：feedTs 倒序，同一毫秒按 sourceId、itemId 倒序（见 server/feed/store.ts）。
 */
export default defineEventHandler(event => guarded(event, async () => (await getFeed()).service.query(getQuery(event))))
