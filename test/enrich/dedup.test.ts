import { describe, expect, it } from "vitest"
import { MIN_FUZZY_LENGTH, dice, keyInfo, similar, titleKey } from "#/enrich/dedup"

describe("标题键", () => {
  it("标点、空白、括号、大小写、全半角不影响", () => {
    const a = titleKey("【快讯】美联储沃勒：12月降息概率 约为70%！")
    const b = titleKey("快讯 美联储沃勒:12月降息概率约为70%")
    expect(a).toBe(b)
    expect(titleKey("Fed’s Waller: December cut “likely”")).toBe(titleKey("FED'S WALLER December CUT likely"))
  })

  it("去掉通讯社前缀与来源后缀", () => {
    const base = titleKey("国家数据局：积极拓展词元服务应用场景")
    expect(titleKey("财联社11月21日电，国家数据局：积极拓展词元服务应用场景")).toBe(base)
    expect(titleKey("金十数据11月21日讯，国家数据局：积极拓展词元服务应用场景")).toBe(base)
    expect(titleKey("国家数据局：积极拓展词元服务应用场景（新华社）")).toBe(base)
    expect(titleKey("国家数据局：积极拓展词元服务应用场景 (财联社)")).toBe(base)
  })

  it("括号里不是来源的内容保留（只去来源括号）", () => {
    expect(titleKey("某公司（002594）发布公告")).not.toBe(titleKey("某公司发布公告"))
  })
})

describe("相似度", () => {
  const info = (t: string) => keyInfo(titleKey(t))

  it("近乎一样（多一个词、少一个标点）算相似", () => {
    expect(similar(info("美联储理事沃勒表示支持12月降息，称劳动力市场疲软迹象明显"), info("美联储理事沃勒表示支持在12月降息，称劳动力市场疲软迹象明显"))).toBe(true)
  })

  it("数字不同不算：套话模板里只差一个数是两件事", () => {
    expect(similar(info("美元指数日内下跌0.3%，报104.52，创一周新低，非美货币普遍走强"), info("美元指数日内下跌0.4%，报104.52，创一周新低，非美货币普遍走强"))).toBe(false)
    expect(similar(info("美元指数日内下跌0.3%，报104.52，创一周新低，非美货币普遍走强"), info("美元指数日内下跌0.3%，报104.52，创一周新低，非美货币普遍走强。"))).toBe(true)
  })

  it("太短的不比（套话短标题撞车）", () => {
    const a = info("美股收盘三大指数涨跌不一")
    expect(a.length).toBeLessThan(MIN_FUZZY_LENGTH)
    expect(similar(a, a)).toBe(false)
  })

  it("主题相同但说的是两件事（只差公司名）不算", () => {
    expect(similar(info("宁德时代发布2026年三季度报告，净利润同比增长百分之三十二"), info("比亚迪发布2026年三季度报告，净利润同比增长百分之三十二"))).toBe(false)
  })

  it("长度悬殊不算（一个是另一个的片段）", () => {
    expect(similar(info("美联储理事沃勒表示支持12月降息"), info("美联储理事沃勒表示支持12月降息，称劳动力市场疲软迹象明显，通胀回落速度快于预期，关税影响可控"))).toBe(false)
  })

  it("dice 系数：相同为 1，毫无共同为 0，对称", () => {
    const a = keyInfo("abcdefgh")
    expect(dice(a, a)).toBe(1)
    expect(dice(keyInfo("abcdef"), keyInfo("uvwxyz"))).toBe(0)
    const b = keyInfo("abcdxxxx")
    expect(dice(a, b)).toBeCloseTo(dice(b, a))
  })
})
