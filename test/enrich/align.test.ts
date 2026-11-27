import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import calendarData from "../../server/enrich/config/calendar.json"
import { logger } from "../../server/utils/logger"
import { alignAt, alignItem, defaultMarketOf, getCalendar, isTradingDay, marketsOf, nextTradingDay, parseCalendar, parseSourceMarkets, resetAlignConfig } from "#/enrich/align"
import { resolveConfig } from "#/enrich/config"

/** 北京时间（UTC+8，没有夏令时）的某一刻 → 毫秒。 */
const bj = (iso: string) => Date.parse(`${iso}+08:00`)
/** 纽约时间的某一刻：传 UTC 偏移（夏令时 -04:00，冬令时 -05:00），用例里写明。 */
const ny = (iso: string, offset: string) => Date.parse(`${iso}${offset}`)

describe("对齐交易日：A 股（Asia/Shanghai）", () => {
  it("15:01 的公告：tradeDate 是下一个交易日，session = post", () => {
    // 2026-11-26 周四 15:01；下一个交易日是周五 11-27
    expect(alignAt(bj("2026-11-26T15:01:00"), "cn")).toEqual({ market: "cn", tradeDate: "2026-11-27", session: "post" })
  })

  it("周五 15:01 的收盘后：下一个交易日是下周一", () => {
    expect(alignAt(bj("2026-11-27T15:01:00"), "cn")).toEqual({ market: "cn", tradeDate: "2026-11-30", session: "post" })
  })

  it("周六的新闻归下周一，session = closed；周日同", () => {
    expect(alignAt(bj("2026-11-28T10:00:00"), "cn")).toEqual({ market: "cn", tradeDate: "2026-11-30", session: "closed" })
    expect(alignAt(bj("2026-11-29T23:59:59"), "cn")).toEqual({ market: "cn", tradeDate: "2026-11-30", session: "closed" })
  })

  it("时段边界（左闭右开）：9:29:59 pre，9:30:00 open，11:29:59 open，11:30:00 lunch，12:59:59 lunch，13:00:00 open，14:59:59 open，15:00:00 post", () => {
    const at = (t: string) => alignAt(bj(`2026-11-27T${t}`), "cn")
    expect(at("00:00:00")).toMatchObject({ session: "pre", tradeDate: "2026-11-27" })
    expect(at("09:29:59")).toMatchObject({ session: "pre", tradeDate: "2026-11-27" })
    expect(at("09:30:00")).toMatchObject({ session: "open", tradeDate: "2026-11-27" })
    expect(at("11:29:59")).toMatchObject({ session: "open" })
    expect(at("11:30:00")).toMatchObject({ session: "lunch", tradeDate: "2026-11-27" })
    expect(at("12:59:59")).toMatchObject({ session: "lunch" })
    expect(at("13:00:00")).toMatchObject({ session: "open" })
    expect(at("14:59:59")).toMatchObject({ session: "open", tradeDate: "2026-11-27" })
    expect(at("15:00:00")).toMatchObject({ session: "post", tradeDate: "2026-11-30" })
    expect(at("23:59:59")).toMatchObject({ session: "post", tradeDate: "2026-11-30" })
  })

  it("休市日的新闻并入节后第一个交易日：国庆（10-01 至 10-07 休市，10-08 开市）", () => {
    expect(alignAt(bj("2026-10-02T10:00:00"), "cn")).toEqual({ market: "cn", tradeDate: "2026-10-08", session: "closed" })
    // 节前最后一个交易日 9-30 收盘后也归 10-08
    expect(alignAt(bj("2026-09-30T16:00:00"), "cn")).toEqual({ market: "cn", tradeDate: "2026-10-08", session: "post" })
    // 调休上班的周六（10-10）交易所不开市，归下周一 10-12
    expect(alignAt(bj("2026-10-10T10:00:00"), "cn")).toEqual({ market: "cn", tradeDate: "2026-10-12", session: "closed" })
  })

  it("春节：2-16 至 2-23 休市（含周一），2-24 开市；2-14 周六", () => {
    expect(alignAt(bj("2026-02-16T10:00:00"), "cn")).toEqual({ market: "cn", tradeDate: "2026-02-24", session: "closed" })
    expect(alignAt(bj("2026-02-14T10:00:00"), "cn")).toEqual({ market: "cn", tradeDate: "2026-02-24", session: "closed" })
    expect(alignAt(bj("2026-02-24T09:00:00"), "cn")).toEqual({ market: "cn", tradeDate: "2026-02-24", session: "pre" })
  })

  it("按北京时间的日期算，不是 UTC：UTC 的 2026-11-27 16:30 已经是北京时间 11-28 周六凌晨", () => {
    expect(alignAt(Date.UTC(2026, 10, 27, 16, 30), "cn")).toEqual({ market: "cn", tradeDate: "2026-11-30", session: "closed" })
  })

  it("2026 年的休市日与交易所公告逐项对得上（公告：「X 日起照常开市」的那天要开，休市区间内的工作日要关）", () => {
    const open = ["2026-01-05", "2026-02-24", "2026-04-07", "2026-05-06", "2026-06-22", "2026-09-28", "2026-10-08"]
    const closedWeekdays = ["2026-01-01", "2026-01-02", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-23", "2026-04-06", "2026-05-01", "2026-05-04", "2026-05-05", "2026-06-19", "2026-09-25", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]
    for (const d of open) expect(isTradingDay(d, "cn"), d).toBe(true)
    for (const d of closedWeekdays) expect(isTradingDay(d, "cn"), d).toBe(false)
    // 公告里的周末休市：2-14、2-28、5-9、9-20、10-10 本来就是周末
    for (const d of ["2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"]) expect(isTradingDay(d, "cn"), d).toBe(false)
  })
})

describe("对齐交易日：美股（America/New_York）", () => {
  it("常规时段 9:30–16:00 ET：夏令时（-04:00）下 9:29 pre、9:30 open、15:59:59 open、16:00 post 归下一个交易日", () => {
    // 2026-07-02 周四；7-03 是独立日休市，7-04/05 周末，下一个交易日是 7-06
    expect(alignAt(ny("2026-07-02T09:29:59", "-04:00"), "us")).toEqual({ market: "us", tradeDate: "2026-07-02", session: "pre" })
    expect(alignAt(ny("2026-07-02T09:30:00", "-04:00"), "us")).toEqual({ market: "us", tradeDate: "2026-07-02", session: "open" })
    expect(alignAt(ny("2026-07-02T15:59:59", "-04:00"), "us")).toEqual({ market: "us", tradeDate: "2026-07-02", session: "open" })
    expect(alignAt(ny("2026-07-02T16:00:00", "-04:00"), "us")).toEqual({ market: "us", tradeDate: "2026-07-06", session: "post" })
  })

  it("冬令时（-05:00）同样按纽约当地时间：2026-11-30 周一 9:30 open", () => {
    expect(alignAt(ny("2026-11-30T09:30:00", "-05:00"), "us")).toEqual({ market: "us", tradeDate: "2026-11-30", session: "open" })
    expect(alignAt(ny("2026-11-30T09:29:00", "-05:00"), "us")).toMatchObject({ session: "pre" })
  })

  it("休市日：感恩节 11-26 归次日 11-27，session = closed；周六归周一", () => {
    expect(alignAt(ny("2026-11-26T10:00:00", "-05:00"), "us")).toEqual({ market: "us", tradeDate: "2026-11-27", session: "closed" })
    expect(alignAt(ny("2026-11-28T10:00:00", "-05:00"), "us")).toEqual({ market: "us", tradeDate: "2026-11-30", session: "closed" })
  })

  it("提前收盘日（感恩节次日 11-27 13:00 ET 收盘）：12:59 open，13:00 post 归下一个交易日 11-30", () => {
    expect(alignAt(ny("2026-11-27T12:59:59", "-05:00"), "us")).toMatchObject({ session: "open", tradeDate: "2026-11-27" })
    expect(alignAt(ny("2026-11-27T13:00:00", "-05:00"), "us")).toEqual({ market: "us", tradeDate: "2026-11-30", session: "post" })
  })

  it("没有午休：中午仍是 open", () => {
    expect(alignAt(ny("2026-11-30T12:00:00", "-05:00"), "us").session).toBe("open")
  })
})

describe("对齐交易日：加密币（24/7）", () => {
  it("按 UTC 自然日，session 一律 open，周末也一样", () => {
    expect(alignAt(Date.UTC(2026, 10, 28, 23, 59, 59), "crypto")).toEqual({ market: "crypto", tradeDate: "2026-11-28", session: "open" })
    expect(alignAt(Date.UTC(2026, 10, 29, 0, 0, 0), "crypto")).toEqual({ market: "crypto", tradeDate: "2026-11-29", session: "open" })
  })

  it("时区可配：改成 Asia/Shanghai，UTC 16:00 已经是北京时间次日", () => {
    const raw = JSON.parse(JSON.stringify(calendarData))
    raw.markets.crypto.timezone = "Asia/Shanghai"
    const cal = parseCalendar(raw)
    expect(alignAt(Date.UTC(2026, 10, 28, 16, 0, 0), "crypto", cal)).toEqual({ market: "crypto", tradeDate: "2026-11-29", session: "open" })
    expect(alignAt(Date.UTC(2026, 10, 28, 15, 59, 59), "crypto", cal)).toEqual({ market: "crypto", tradeDate: "2026-11-28", session: "open" })
  })
})

describe("一条新闻涉及哪些市场", () => {
  it("按标的的场所推出：沪深北 → cn，美股交易所 → us，币安 → crypto；多个市场按 cn、us、crypto 的固定顺序", () => {
    expect(marketsOf(["600519.XSHG"], "jin10")).toEqual(["cn"])
    expect(marketsOf(["000001.XSHE", "920992.BJSE"], "jin10")).toEqual(["cn"])
    expect(marketsOf(["AAPL.XNAS"], "jin10")).toEqual(["us"])
    expect(marketsOf(["BRK.B.XNYS"], "jin10")).toEqual(["us"])
    expect(marketsOf(["BTCUSDT.BINANCE", "AAPL.XNAS", "600519.XSHG"], "jin10")).toEqual(["cn", "us", "crypto"])
  })

  it("没有标的按来源的默认市场：美股向的预置订阅包与 hackernews → us，其余内置源 → cn", () => {
    expect(marketsOf([], "user:preset-reuters-markets")).toEqual(["us"])
    expect(marketsOf([], "user:preset-bloomberg-economics")).toEqual(["us"])
    expect(marketsOf([], "user:preset-reddit-wallstreetbets")).toEqual(["us"])
    expect(marketsOf([], "hackernews")).toEqual(["us"])
    expect(marketsOf([], "jin10")).toEqual(["cn"])
    expect(marketsOf([], "user:my-own-feed")).toEqual(["cn"])
  })

  it("标的的场所都不认识时退回来源默认；有认识的就只按标的", () => {
    expect(marketsOf(["X.ZZZZ"], "hackernews")).toEqual(["us"])
    expect(marketsOf(["600519.XSHG"], "hackernews")).toEqual(["cn"])
  })

  it("alignItem：一条涉及两个市场的新闻对齐出两项，各按各的日历（A 股收盘后 vs 美股盘中）", () => {
    // 北京时间 2026-11-30 周一 22:30 = 纽约 09:30（-05:00）：A 股早已收盘（post → 12-01），美股刚开盘
    const out = alignItem(bj("2026-11-30T22:30:00"), ["600519.XSHG", "AAPL.XNAS"], "jin10")
    expect(out).toEqual([
      { market: "cn", tradeDate: "2026-12-01", session: "post" },
      { market: "us", tradeDate: "2026-11-30", session: "open" },
    ])
  })

  it("defaultMarketOf 先匹配先得；前缀以 * 结尾", () => {
    const sm = parseSourceMarkets({ default: "cn", sources: [{ match: "a*", market: "us" }, { match: "ab", market: "crypto" }] })
    expect(defaultMarketOf("ab", sm)).toBe("us")
    expect(defaultMarketOf("b", sm)).toBe("cn")
  })
})

describe("交易日历", () => {
  it("nextTradingDay 严格晚于给定日期，跳过周末与休市日", () => {
    expect(nextTradingDay("2026-11-27", "cn")).toBe("2026-11-30")
    expect(nextTradingDay("2026-09-24", "cn")).toBe("2026-09-28")
    expect(nextTradingDay("2026-12-24", "us")).toBe("2026-12-28") // 12-25 圣诞休市，12-26/27 周末
  })

  it("没覆盖的年份只按周末算，并且只警告一次", () => {
    resetAlignConfig()
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    try {
      // 2027-01-04 周一（元旦调休之类没数据）：按周末算就是 open
      expect(alignAt(bj("2027-01-04T10:00:00"), "cn")).toMatchObject({ session: "open", tradeDate: "2027-01-04" })
      expect(alignAt(bj("2027-01-05T10:00:00"), "cn")).toMatchObject({ session: "open" })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain("2027")
    } finally {
      warn.mockRestore()
    }
  })

  it("配置校验：坏时区、时段重叠、休市区间倒置、场所重复都会报错", () => {
    const bad = (mutate: (raw: any) => void) => {
      const raw = JSON.parse(JSON.stringify(calendarData))
      mutate(raw)
      return () => parseCalendar(raw)
    }
    expect(bad(r => (r.markets.cn.timezone = "Mars/Olympus"))).toThrow(/时区/)
    expect(bad(r => (r.markets.cn.open = [["09:30", "11:30"], ["11:00", "15:00"]]))).toThrow(/重叠/)
    expect(bad(r => (r.markets.cn.open = [["9:30", "11:30"]]))).toThrow(/HH:MM/)
    expect(bad(r => (r.markets.cn.closed[0] = { from: "2026-01-03", to: "2026-01-01", name: "x" }))).toThrow(/晚于/)
    expect(bad(r => (r.markets.cn.closed[0] = { from: "2026-02-30", to: "2026-02-30", name: "x" }))).toThrow(/有效日期/)
    expect(bad(r => (r.markets.us.venues = ["XSHG"]))).toThrow(/同时属于/)
    expect(bad(r => delete r.markets.crypto)).toThrow(/crypto/)
  })
})

describe("配置文件可改：ENRICH_CONFIG_DIR 覆盖打包的那份", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    resetAlignConfig()
  })
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "enrich-config-"))
    dirs.push(d)
    return d
  }

  it("覆盖文件通过校验就用它（把 A 股午休改成 11:30–12:30 开盘，12:00 就是 open）", () => {
    const dir = tmp()
    const raw = JSON.parse(JSON.stringify(calendarData))
    raw.markets.cn.open = [["09:30", "15:00"]]
    writeFileSync(join(dir, "calendar.json"), JSON.stringify(raw))
    const cal = resolveConfig("calendar", calendarData, parseCalendar, { ENRICH_CONFIG_DIR: dir })
    expect(alignAt(bj("2026-11-27T12:00:00"), "cn", cal).session).toBe("open")
    expect(alignAt(bj("2026-11-27T12:00:00"), "cn", getCalendar()).session).toBe("lunch")
  })

  it("覆盖文件坏了（JSON 错、没通过校验）退回打包的，并警告；没这份文件就静默用打包的", () => {
    const dir = tmp()
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    try {
      writeFileSync(join(dir, "calendar.json"), "{ not json")
      const a = resolveConfig("calendar", calendarData, parseCalendar, { ENRICH_CONFIG_DIR: dir })
      expect(alignAt(bj("2026-11-27T12:00:00"), "cn", a).session).toBe("lunch")
      writeFileSync(join(dir, "calendar.json"), JSON.stringify({ markets: {} }))
      const b = resolveConfig("calendar", calendarData, parseCalendar, { ENRICH_CONFIG_DIR: dir })
      expect(alignAt(bj("2026-11-27T12:00:00"), "cn", b).session).toBe("lunch")
      expect(warn).toHaveBeenCalledTimes(2)
      warn.mockClear()
      const c = resolveConfig("source-markets", { default: "us", sources: [] }, parseSourceMarkets, { ENRICH_CONFIG_DIR: dir })
      expect(c.default).toBe("us")
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
