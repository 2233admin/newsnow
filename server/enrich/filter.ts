import type { FilterReason } from "./types"

/**
 * 规则层（#2188 补充，免费、确定性）：过滤荐股软文、榜单水文、广告、行情罗列，给出过滤原因。
 * 结构参照 owengetinfo-design/PokieTicker 的 backend/pipeline/layer0.py（MIT License，Copyright (c) 2025 PokieTicker）：
 * 规则按顺序判断、命中即给原因、入库时只记原因不删数据；它的「标题里点名超过 10 个标的就是行情罗列」（market_roundup）与英文榜单两条
 * （`^\d+ best|top…`、`top|best|worst N`）在这里沿用，其余规则（荐股话术、联系方式引流、中文榜单、广告标记）是针对中文财经快讯写的。
 * 误杀的修正（独立审 S2）：保险 / 理财的「保证收益」「稳赚」要选股语境；监管提醒、警方抓获类放行；「100%涨停」前不能是数字；英文榜单要选股语境；
 * 「金股」不算榜单；行情罗列要同时有汇总词。
 * 它的「描述为空 / 太短」两条这里没有：我们只有标题，没有描述。
 *
 * 取舍：宁漏勿错——被过滤的条目默认查不出来，误杀一条真消息比漏掉一条软文更糟。所以规则都要求软文的「形」（引流话术、收益承诺、榜单格式、广告标记），
 * 不是出现某个词就算；报道监管查处荐股、提醒防骗的新闻（带「警惕、通报、查处」之类）一律放行。规则是照手头的样例写的，没有在大样本上量过误杀率，
 * 见 test/enrich/filter.test.ts 的正反例；漏掉的软文靠后面批量标注层与人工，误杀的可用 includeFiltered=1 查回。
 *
 * 被过滤的条目仍然入库、仍然参与去重分组，只是默认不出现在查询里（includeFiltered=1 查得到）。
 */

export const FILTER_REASON_LABELS: Record<FilterReason, string> = {
  advert: "广告 / 推广",
  stock_tout: "荐股软文",
  ranking_list: "榜单水文",
  market_roundup: "行情罗列",
}

/** 标题里点名的标的多于这个数就算行情罗列。同 layer0.py 的 `len(tickers) > 10`。 */
export const ROUNDUP_SYMBOLS = 10

/** 报道查处、提醒防范荐股骗局的新闻：话术出现在这里是被报道的对象，不是软文本身，放行。 */
const WARNING_CONTEXT = /警惕|警示|提醒(?:广大)?(?:投资者|股民|市民|公众|消费者)|监管提醒|(?:不要|切勿|勿|别)轻信|谨防|防范|风险提示|严查|查处|打击|抓获|破获|通报|处罚|罚款|被罚|罚没|没收|不得|骗局|诈骗|涉嫌|立案|获刑|判刑|整治|叫停|违规|非法荐股|非法证券/

/** 广告标记：括号 / 方括号里的「广告、推广、赞助」，或开头的「广告：」；英文的 Sponsored / Advertisement 标记。 */
const ADVERT = [
  /[【[（(]\s*(?:广告|推广|商务合作|赞助(?:内容)?|软文)\s*[】\]）)]/,
  /^\s*(?:广告|推广|赞助内容)\s*[:：]/,
  /^\s*(?:sponsored|advertisement|advertorial|promoted)(?:\s+(?:content|post))?\s*[:\-–|]/i,
  /[[(]\s*(?:sponsored|advertisement|paid\s+post)\s*[\])]/i,
]

/**
 * 荐股软文，三类话术：
 * 1. 强引流：加微信 / 加 V、带单老师、喊单、跟老师操作、免费入群、内部群。「增加微信」「新增微信」不算（前面有「增、新、附、追」的「加」不是动词「加」）。
 * 2. 收益承诺：明日必涨停、翻倍牛股、牛股推荐 / 曝光 / 揭秘、庄家控盘、即将暴涨（这些本身就是选股话术）；稳赚、包赚、保证收益 / 盈利在保险、理财新闻里是正常词
 *    （「增额终身寿险保证收益率下调」「理财产品不得宣传稳赚」），要标题里同时有选股语境才算（同弱引流）。
 * 3. 弱引流（扫码、免费领、关注公众号、私信）：本身常见于正常消息（扫码支付），要标题里同时有选股语境（牛股、荐股、涨停、个股……）才算。
 */
const TOUT_STRONG = /(?<![增新附追])加\s*(?:(?:我|老师|助理|客服)\s*)?(?:微信|V信|VX|vx|威信|薇信|QQ)|添加\s*(?:微信|客服|助理)|(?:免费|限时)\s*(?:入群|进群)|(?:内部|VIP|vip)\s*(?:交流)?群|(?:老师|导师)\s*带(?:你|单)|带单(?:老师|导师)|喊单|跟着?(?:老师|我)(?:操作|做|买)/
const TOUT_PROMISE = /(?:明日|明天|下周)\s*(?:必|将|即将)\s*(?:涨停|暴涨|大涨|翻倍)|必涨|(?:翻倍|暴涨|涨停)(?:牛股|黑马)|(?:牛股|黑马)(?:推荐|曝光|预告|揭秘|来袭)|(?:推荐|荐)(?:牛股|黑马)|潜力(?:牛股|黑马)|庄家(?:控盘|拉升|启动)|即将(?:暴涨|起飞)|(?<![\d.])100%\s*(?:盈利|上涨|涨停|胜率)/
/** 收益承诺里「保险 / 理财也常用」的词：要选股语境才算软文。 */
const TOUT_RETURN = /稳赚|包赚|保证(?:收益|盈利)/
const TOUT_WEAK = /扫码|扫描二维码|扫二维码|免费领取|免费领|免费获取|免费送|关注公众号|私信/
const PICK_CONTEXT = /牛股|荐股|诊股|选股|个股|股票|涨停|黑马|操盘|行情/

/** 中文榜单水文：十大牛股、涨幅榜前十、资金流入排行榜。龙虎榜是交易所披露的数据，不在其内。 */
const RANK_CN = [
  /(?:十大|[1-9]\d?大|TOP\s?\d+|前\s?\d+\s?(?:名|强)).{0,8}(?:牛股|黑马|潜力股|热门股|强势股|龙头股|概念股)/i,
  /(?:涨幅|跌幅|成交额|成交量|换手率|人气|热门|热度|资金流入|资金流出|净流入|净流出|主力资金)\s*(?:榜|排行|排名)/,
  /^\s*(?:【\s*)?(?:盘点|一览|速览)\s*(?:[:：】]\s*)?(?:今日|本周|本月)?.{0,6}(?:牛股|黑马|涨停股|潜力股)/,
]
/** 英文榜单：同 layer0.py 的两条，但限定在选股的语境里（它原样的 `top|best|worst N` 会放过「Fed's top 2 officials」这类）。 */
const RANK_EN = [
  /^\s*\d+\s+(?:best|top|worst|biggest|largest|most|highest|lowest)\s+(?:[\w'’-]+\s+){0,5}?(?:stocks?|picks?|etfs?|coins?|cryptos?|shares|buys?|dividend)\b/i,
  /\b(?:stocks?|etfs?|cryptos?|coins?)\s+to\s+buy\s+(?:now|today|right\s+now|before|this\s+(?:week|month|year))/i,
]

/** 行情罗列要标题里同时有汇总类的词：只是点名多个标的（指数样本调整、批量公告）不算。同 layer0.py 的前提是英文美股行情汇总。 */
const ROUNDUP_WORDS = /涨幅|跌幅|涨停|跌停|榜|盘点|收盘|收评|午评|早盘|午盘|尾盘|集锦|异动|一览|速览|汇总|复盘|行情|gainers|losers|movers|roundup|recap|wrap|closing/i

/** 「Top 10 stocks account for 35% of S&P 500 weight」这类描述市场结构的不算榜单：「top|best|worst N 加标的名词」要同时有选股 / 买卖的语境才算。 */
const RANK_EN_LOOSE = /\b(?:top|best|worst)\s+\d+\s+(?:\w+\s+){0,3}(?:stocks?|picks?|etfs?|coins?|cryptos?|shares|funds?|dividend)/i
const EN_PICK_CONTEXT = /\bto\s+(?:buy|own|watch|sell|invest)\b|\b(?:buy|sell|picks?|recommend\w*|ideas?|bargains?|before|now|today)\b|\b(?:in|for|of)\s+20\d\d\b|\bthis\s+(?:week|month|year)\b/i

export function filterTitle(title: string, symbols: string[] = []): FilterReason | null {
  const t = title.normalize("NFKC")
  if (ADVERT.some(r => r.test(t))) return "advert"
  if (!WARNING_CONTEXT.test(t) && (TOUT_STRONG.test(t) || TOUT_PROMISE.test(t) || ((TOUT_WEAK.test(t) || TOUT_RETURN.test(t)) && PICK_CONTEXT.test(t)))) return "stock_tout"
  if (RANK_CN.some(r => r.test(t)) || RANK_EN.some(r => r.test(t)) || (RANK_EN_LOOSE.test(t) && EN_PICK_CONTEXT.test(t))) return "ranking_list"
  if (symbols.length > ROUNDUP_SYMBOLS && ROUNDUP_WORDS.test(t)) return "market_roundup"
  return null
}
