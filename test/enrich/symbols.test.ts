import { describe, expect, it } from "vitest"
import { SYMBOL_ID, extractSymbols, getMatcher } from "#/enrich/symbols"
import ashare from "#/enrich/dict/ashare.json"
import us from "#/enrich/dict/us.json"
import crypto from "#/enrich/dict/crypto.json"
import aliases from "#/enrich/dict/aliases.json"

const ids = (title: string) => extractSymbols(title)

describe("三字以上的常用词简称要语境（审阅 #8 第 6 项）", () => {
  it("农产品、新世界、机器人：没有股票语境不认；有语境才认", () => {
    expect(ids("美国总统特朗普：亚洲之行成果斐然，菲律宾将采购美国农产品。")).toEqual([])
    expect(ids("新世界的大门已经打开")).toEqual([])
    expect(ids("人形机器人量产在即")).toEqual([])
    expect(ids("农产品板块早盘拉升")).toEqual(["000061.XSHE"])
    expect(ids("新世界股价涨停")).toEqual(["600628.XSHG"])
  })

  it("几乎只指公司的名字不受影响", () => {
    expect(ids("中国移动发布三季报")).toEqual(["600941.XSHG"])
    expect(ids("五粮液：回购股份")).toEqual(["000858.XSHE"])
  })

  it("名单里的词在词典里都是真的 A 股简称", () => {
    const names = new Set(ashare.map(r => r[2] as string))
    for (const w of aliases.stop.ctx) expect([...names].some(n => n.includes(w)), w).toBe(true)
  })
})

describe("词典：新浪除权日的截短简称（审阅 #8 第 2 项）", () => {
  it("简称里没有 XD / XR / DR / N / C 前缀（它们的名字被截短，会误命中）", () => {
    expect(ashare.filter(r => /^(?:XD|XR|DR|N|C)[\u3400-\u9FFF]/.test(r[2] as string))).toEqual([])
  })

  it("「中国中央……」「中信银河」不是中国中免、中信银行；全称才是", () => {
    expect(ids("中国中央银行宣布降息")).toEqual([])
    expect(ids("中国中央电视台报道")).toEqual([])
    expect(ids("中信银河证券发布研报")).toEqual([])
    expect(ids("渤海轮船公司")).toEqual([])
    expect(ids("中国中免发布三季报")).toEqual(["601888.XSHG"])
    expect(ids("中信银行（601998）发布公告")).toEqual(["601998.XSHG"])
  })
})

describe("词典", () => {
  it("规模与格式：每个 id 都是「代码.场所」，场所在 KATANAview 登记过的集合里", () => {
    const venues = new Set(["XSHG", "XSHE", "BJSE", "XNAS", "XNYS", "ARCX", "XASE", "BATS", "IEXG", "BINANCE"])
    expect(ashare.length).toBeGreaterThan(5000)
    expect(us.length).toBeGreaterThanOrEqual(2000)
    expect(crypto.length).toBeGreaterThanOrEqual(40)
    const all = [
      ...ashare.map(r => `${r[0]}.${{ sh: "XSHG", sz: "XSHE", bj: "BJSE" }[r[1] as string]}`),
      ...us.map(r => `${r[0]}.${r[1]}`),
      ...crypto.map(r => r[1] as string),
    ]
    for (const id of all) {
      expect(SYMBOL_ID.test(id), id).toBe(true)
      expect(venues.has(id.slice(id.lastIndexOf(".") + 1)), id).toBe(true)
    }
    expect(new Set(all).size).toBe(all.length)
  })

  it("a 股代码段与场所对得上（60/68/9 沪；00/30/20 深；4/8/92 北）", () => {
    for (const [code, mkt] of ashare as [string, string, string][]) {
      const expected = /^(?:6|9[01])/.test(code) ? "sh" : /^[023]/.test(code) ? "sz" : "bj"
      // 920xxx 是北交所新代码段，900xxx 是沪 B 股
      if (code.startsWith("92")) expect(mkt, code).toBe("bj")
      else expect(mkt, code).toBe(expected)
    }
  })
})

describe("a 股", () => {
  it("简称：茅台 600519.XSHG、深市 000858.XSHE、北交所", () => {
    expect(ids("贵州茅台发布三季报")).toEqual(["600519.XSHG"])
    expect(ids("五粮液涨停")).toEqual(["000858.XSHE"])
    expect(ids("宁德时代与比亚迪签约")).toEqual(["300750.XSHE", "002594.XSHE"])
  })

  it("代码：括号里、带场所前缀或后缀的认，裸的六位数不认", () => {
    expect(ids("贵州（600519）公告")).toEqual(["600519.XSHG"])
    expect(ids("sh600519 涨停")).toEqual(["600519.XSHG"])
    expect(ids("600519.SH 公告")).toEqual(["600519.XSHG"])
    expect(ids("000858.SZ 公告")).toEqual(["000858.XSHE"])
    expect(ids("股票代码：600519")).toEqual(["600519.XSHG"])
    expect(ids("成交额 600519 万元")).toEqual([])
    expect(ids("订单 600519 号")).toEqual([])
  })

  it("代码的场所对不上不认（000858 在深市，写成 .SH 不是它）；000001 没有场所标记不认（上证指数）", () => {
    expect(ids("000858.SH")).toEqual([])
    expect(ids("上证指数（000001）收涨")).toEqual([])
    expect(ids("平安银行（000001.SZ）公告")).toContain("000001.XSHE")
  })

  it("两个字的简称需要股票语境，普通词不认", () => {
    expect(ids("经济发展提速，新标准出台")).toEqual([])
    expect(ids("春天来了，美丽乡村建设")).toEqual([])
    expect(ids("溅落太平洋")).toEqual([])
    expect(ids("核心驱动力")).toEqual([])
  })

  it("st 前缀去掉后匹配，但需要语境", () => {
    expect(ids("ST恒信股东大会上演闹剧，多名股东被挡")).toEqual(["300081.XSHE"])
  })

  it("同名的 a 股与美股不收（百济神州），媒体名不收（人民网）", () => {
    expect(ids("百济神州公告")).toEqual([])
    expect(ids("人民网报道")).toEqual([])
  })
})

describe("美股", () => {
  it("中文名：英伟达、特斯拉、阿里巴巴（ADR）、拼多多", () => {
    expect(ids("英伟达财报超预期，特斯拉大涨")).toEqual(["NVDA.XNAS", "TSLA.XNAS"])
    expect(ids("阿里巴巴与拼多多")).toEqual(["BABA.XNYS", "PDD.XNAS"])
    expect(ids("台积电扩产")).toEqual(["TSM.XNYS"])
  })

  it("强信号：$AAPL、括号、交易所前缀、路透风格代码", () => {
    expect(ids("$AAPL breaks out")).toEqual(["AAPL.XNAS"])
    expect(ids("Apple (AAPL) rises")).toEqual(expect.arrayContaining(["AAPL.XNAS"]))
    expect(ids("阿里巴巴（BABA.N）盘前涨")).toEqual(expect.arrayContaining(["BABA.XNYS"]))
    expect(ids("NYSE: BABA jumps")).toEqual(["BABA.XNYS"])
    expect(ids("纳斯达克：NVDA 创新高")).toEqual(["NVDA.XNAS"])
    expect(ids("Class B shares ($BRK.B)")).toEqual(["BRK.B.XNYS"])
  })

  it("单独的常见英文词不认：ALL、IT、ON、A、F、T", () => {
    for (const title of ["ALL IN on AI", "IT stocks fall", "ON the rise", "A rally", "F and T lines", "Fed said ALL good", "(A) 第一项 (C) 第三项"]) {
      expect(ids(title), title).toEqual([])
    }
    expect(ids("Palo Alto and ALL others")).toEqual(["PANW.XNAS"].filter(() => false))
  })

  it("括号里的宏观缩写不认：(CPI)、(GDP)、(AI)、(IPO)、(ETF)", () => {
    expect(ids("美国消费者物价指数(CPI)高于预期，GDP(季调)，AI(人工智能)概念，IPO(首次公开募股)，ETF")).toEqual([])
  })

  it("英文公司名：多词全称认，单个词只认别名表；普通英文词不认", () => {
    expect(ids("Advanced Micro Devices said")).toEqual(["AMD.XNAS"])
    expect(ids("Nvidia and Tesla slid")).toEqual(["NVDA.XNAS", "TSLA.XNAS"])
    expect(ids("Goldman Sachs warns")).toEqual(["GS.XNYS"])
    expect(ids("The target date and a block of seats; ford the river; visa rules; snap judgment")).toEqual([])
    expect(ids("nvidia lowercase is not a company mention")).toEqual([])
  })

  it("同一家公司的几个股份类别取市值靠前的一个（伯克希尔），不是两个", () => {
    expect(ids("伯克希尔-哈撒韦加仓")).toHaveLength(1)
    expect(ids("Berkshire Hathaway buys")).toHaveLength(1)
  })
})

describe("加密币", () => {
  it("中文名与英文名", () => {
    expect(ids("比特币突破60000美元，以太坊跟涨")).toEqual(["BTCUSDT.BINANCE", "ETHUSDT.BINANCE"])
    expect(ids("Bitcoin and Ethereum rally")).toEqual(["BTCUSDT.BINANCE", "ETHUSDT.BINANCE"])
    expect(ids("狗狗币暴涨")).toEqual(["DOGEUSDT.BINANCE"])
  })

  it("比特币现金是 BCH 不是 BTC（最长匹配）", () => {
    expect(ids("比特币现金分叉")).toEqual(["BCHUSDT.BINANCE"])
  })

  it("代码：独立的大写 BTC、$SOL、BTC/USDT、BTCUSDT 认；像英文单词的与小写不认", () => {
    expect(ids("BTC 跌破 5 万")).toEqual(["BTCUSDT.BINANCE"])
    expect(ids("$SOL up")).toEqual(["SOLUSDT.BINANCE"])
    expect(ids("BTC/USDT 永续 与 ETHUSDT")).toEqual(["BTCUSDT.BINANCE", "ETHUSDT.BINANCE"])
    expect(ids("near the sky, a pump in the night, just hype")).toEqual([])
    expect(ids("NEAR SKY NIGHT PUMP")).toEqual([])
    expect(ids("btc is lowercase")).toEqual([])
    expect(ids("DOGE 部门削减预算")).toEqual([])
  })

  it("稳定币不收：USDT、USDC 不是标的", () => {
    expect(ids("USDT 溢价 USDC 增发")).toEqual([])
  })
})

describe("输出", () => {
  it("每个 id 只出现一次，按首次出现的先后；空标题与纯符号不报错", () => {
    expect(ids("英伟达、英伟达、英伟达与特斯拉")).toEqual(["NVDA.XNAS", "TSLA.XNAS"])
    expect(ids("")).toEqual([])
    expect(ids("！！！")).toEqual([])
  })

  it("全角括号与全角字母归一后也认", () => {
    expect(ids("英伟达（ＮＶＤＡ.Ｏ）")).toEqual(["NVDA.XNAS"])
  })

  it("建词典的统计：同名跨市场的被丢掉并记录", () => {
    const stats = getMatcher().stats
    expect(stats.ambiguousDropped.some(s => s.startsWith("百济神州="))).toBe(true)
  })
})
