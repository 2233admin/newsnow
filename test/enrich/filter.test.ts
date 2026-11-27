import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import { describe, expect, it } from "vitest"
import { FILTER_REASON_LABELS, ROUNDUP_SYMBOLS, filterTitle } from "#/enrich/filter"
import { extractSymbols } from "#/enrich/symbols"
import type { FilterReason } from "#/enrich/types"

describe("规则层：过滤荐股软文、榜单水文、广告、行情罗列", () => {
  const spam: [FilterReason, string][] = [
    // 广告标记
    ["advert", "【广告】某某证券开户福利，万一免五"],
    ["advert", "新能源车企发布新品（推广）"],
    ["advert", "赞助内容：如何选择适合你的券商"],
    ["advert", "Sponsored: Why this AI stock is a must-own"],
    ["advert", "Advertisement - open a brokerage account today"],
    // 荐股软文：引流
    ["stock_tout", "加微信领取今日牛股名单，限时免费"],
    ["stock_tout", "免费入群，老师带你抓涨停"],
    ["stock_tout", "跟着老师操作，本周已翻倍"],
    ["stock_tout", "扫码免费领取牛股，附最新个股行情"],
    ["stock_tout", "内部群曝光：下周龙头股名单"],
    // 荐股软文：收益承诺
    ["stock_tout", "这只股票稳赚不赔，机构都在抢筹"],
    ["stock_tout", "明日必涨停的三只黑马，速看"],
    ["stock_tout", "翻倍牛股即将启动，错过再等一年"],
    ["stock_tout", "牛股推荐：本周最强潜力股曝光"],
    ["stock_tout", "庄家控盘拉升在即，短线必涨"],
    // 榜单水文
    ["ranking_list", "十大牛股盘点：谁是年度最强"],
    ["ranking_list", "本周涨幅榜前十，第一名翻了三倍"],
    ["ranking_list", "主力资金净流入排行榜：这些股票被疯抢"],
    ["ranking_list", "TOP10 概念股排名出炉"],
    ["ranking_list", "10 best stocks to buy right now"],
    ["ranking_list", "Top 5 dividend stocks for 2027"],
    ["ranking_list", "3 stocks to buy now before the rally"],
  ]
  it.each(spam)("%s：%s", (reason, title) => {
    expect(filterTitle(title)).toBe(reason)
  })

  it("行情罗列：标题里点名的标的多于 10 个", () => {
    const many = Array.from({ length: ROUNDUP_SYMBOLS + 1 }, (_, i) => `S${i}.XNAS`)
    expect(filterTitle("今日涨停股一览", many)).toBe("market_roundup")
    expect(filterTitle("今日涨停股一览", many.slice(0, ROUNDUP_SYMBOLS))).toBeNull()
  })

  it("每种过滤原因都有中文名", () => {
    for (const r of ["advert", "stock_tout", "ranking_list", "market_roundup"] as FilterReason[]) expect(FILTER_REASON_LABELS[r]).toBeTruthy()
  })
})

describe("规则层：正常新闻不误杀", () => {
  const fine = [
    // 报道监管查处、提醒防骗：话术出现在被报道的对象里
    "证监会通报非法荐股案：多名博主以加微信领牛股为名诈骗投资者",
    "警惕！以免费入群、带单老师为幌子的荐股骗局频发",
    "某投顾公司因承诺稳赚被罚款 300 万元",
    // 出现了「广告」「榜」「加微信」字样但不是软文
    "腾讯：第三季度广告收入同比增长 15%，微信视频号广告库存扩大",
    "支付宝新增微信小程序入口，扫码支付覆盖更多商户",
    "A 股收盘：沪指涨 0.5%，两市成交额破万亿，涨幅居前的有色板块领涨",
    "龙虎榜：机构净买入某某科技 1.2 亿元",
    "科创板 3 只个股涨幅超过 20%，半导体概念活跃",
    "上交所：十大流通股东名单变更需及时披露",
    "Fed's top 2 officials signal patience on rate cuts",
    "Apple hires top 10 engineers from rival chipmaker",
    // 普通公告、宏观、币圈
    "贵州茅台：控股股东拟增持不低于 1 亿元",
    "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范",
    "美联储理事：通胀仍有粘性，降息需要更多证据",
    "SEC approves spot ether ETF options trading",
    "比特币突破 10 万美元，24 小时爆仓 5 亿美元",
    "公司股价翻倍后遭监管问询，要求说明炒作原因",
  ]
  it.each(fine)("%s", (title) => {
    expect(filterTitle(title, extractSymbols(title))).toBeNull()
  })

  it("真实采集的 200 条财经快讯（test/fixtures/enrich-sample.json）一条都不过滤", () => {
    const samples = (JSON.parse(readFileSync(resolve(process.cwd(), "test/fixtures/enrich-sample.json"), "utf8")) as { samples: { title: string }[] }).samples
    expect(samples.length).toBe(200)
    const filtered = samples.filter(s => filterTitle(s.title, extractSymbols(s.title)) !== null).map(s => s.title)
    expect(filtered).toEqual([])
  })
})
