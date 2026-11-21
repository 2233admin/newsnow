/**
 * 生成标的词典（#2188）：`pnpm exec tsx scripts/gen-symbol-dict.ts [ashare|us|crypto|all]`，需要联网；结果写到 server/enrich/dict/，提交进仓库。
 * 词典是数据，不在运行时联网取：运行时只读这几个 JSON。多久重生成一次没定（A 股每周几只新股、更名；美股前 2000 名变化慢；币前 100 名几个月动一次）。
 *
 * 来源与读取日期 2026-11-22（本沙箱可达）：
 * - A 股：新浪行情 Market_Center.getHQNodeData?node=hs_a（沪、深、北三市全部 A 股，5579 只），需 Referer: https://finance.sina.com.cn/ ；
 *   name 是简称，JSON 里已转义成 \uXXXX，所以不受 GBK 影响。
 * - 美股：纳斯达克交易所公开的上市清单 nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt 与 otherlisted.txt（代码、英文名、上市交易所、ETF 与测试标记），
 *   再用新浪美股列表 US_CategoryService.getList（按市值倒序，每页最多 20 条）取中文名与市值，取市值前 US_TOP_N 名。
 *   SEC 的 company_tickers_exchange.json 对没有联系方式的请求返回 403，没用。
 * - crypto：CoinGecko coins/markets 市值前 100，与币安现货 USDT 交易对（data-api.binance.vision/api/v3/exchangeInfo，api.binance.com 在本沙箱 451）取交集。
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import process from "node:process"

const OUT = fileURLToPath(new URL("../server/enrich/dict/", import.meta.url))
/** 美股取市值前多少名。待定：2000 约相当于 Russell 1000 + 一部分小盘与中概；没有按漏报率推出，准确率与召回率的抽样里看漏掉的是不是被它挡掉的。 */
const US_TOP_N = 2000
/** 加密币取市值前多少名（去掉稳定币、再与币安 USDT 现货交集）。依据：行情单面向主流币，前 100 覆盖日常新闻里出现的币。 */
const CRYPTO_TOP_N = 100
const UA = "Mozilla/5.0 (newsnow-enrich-dict-generator)"

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function get(url: string, headers: Record<string, string> = {}, tries = 4): Promise<string> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(30_000) })
      if (res.ok) return await res.text()
      if (res.status !== 429 && res.status < 500) throw new Error(`${url} → ${res.status}`)
    } catch (e) {
      if (i === tries - 1) throw e
    }
    await sleep(1500 * (i + 1))
  }
  throw new Error(`${url} 取不到`)
}

const write = (name: string, value: unknown) => writeFileSync(OUT + name, `${JSON.stringify(value)}\n`)

/**
 * 新浪在除权除息日、新股上市首日给简称加 XD / XR / DR / N / C 前缀，并把名字截短（2026-11-22 的 601888 是「XD中国中」，真名中国中免）。
 * 截短后的名字（「中国中」「中信银」）会在新闻里误命中（「中国中央银行」），所以带这些前缀的一律不收新浪给的名字：
 * 下面的表里有全称的用全称，没有的丢掉并打印出来，交给人补。
 * 表的核对（2026-11-22 读）：新浪 hq.sinajs.cn 给的都是截短的 XD 名，不能用。沪市四只取上交所 query.sse.com.cn（STOCK_TYPE 1 / 8 的股票列表）的
 * COMPANY_ABBR：中国中免、中信银行、渤海轮渡、阿拉丁（它的 SEC_NAME_FULL「XD阿拉丁科技」是带 XD 的扩展名，不是简称）；
 * 北交所两只：北交所官网 bse.cn 的简称也被截短（XD维琪科、XD百瑞吉），取巨潮资讯 cninfo.com.cn 的 zwjc：维琪科技、百瑞吉。
 * 阿拉丁、百瑞吉本来就是三个字，没被截；表里照写，免得带前缀被丢。
 */
const PREFIXED = /^(?:XD|XR|DR|N|C)(?=[\u3400-\u9FFF])/
const FULL_NAMES: Record<string, string> = {
  601888: "中国中免",
  601998: "中信银行",
  603167: "渤海轮渡",
  920176: "维琪科技",
  920201: "百瑞吉",
  688179: "阿拉丁",
}

async function ashare() {
  const rows: [string, string][] = []
  const base = "http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData"
  for (let page = 1; page < 100; page++) {
    const text = await get(`${base}?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`, { referer: "https://finance.sina.com.cn/" })
    const list = JSON.parse(text) as { symbol: string, code: string, name: string }[]
    if (!list.length) break
    for (const r of list) rows.push([r.symbol, r.name.replace(/\s+/g, "")]) // 新浪给三个字的简称补空格（「五 粮 液」）
    await sleep(150)
  }
  // 代码前缀 sh / sz / bj 决定场所（XSHG / XSHE / BJSE）
  const bad = rows.filter(([s]) => !/^(?:sh|sz|bj)\d{6}$/.test(s))
  if (bad.length) throw new Error(`A 股代码格式不对：${bad.slice(0, 3)}`)
  const kept: [string, string][] = []
  for (const [symbol, name] of rows) {
    if (!PREFIXED.test(name)) {
      kept.push([symbol, name])
      continue
    }
    const full = FULL_NAMES[symbol.slice(2)]
    if (full) kept.push([symbol, full])
    else console.warn(`丢掉带临时前缀的简称（名字可能被截短，请查全称补进 FULL_NAMES）：${symbol} ${name}`)
  }
  if (kept.some(([, n]) => PREFIXED.test(n))) throw new Error("A 股简称里还有 XD / XR / DR / N / C 前缀")
  console.log(`A 股 ${kept.length} 只（${rows.length - kept.length} 只带临时前缀的丢掉了）`)
  write("ashare.json", kept.map(([s, n]) => [s.slice(2), s.slice(0, 2), n]))
}

const US_MIC: Record<string, string> = { N: "XNYS", A: "XASE", P: "ARCX", Z: "BATS", V: "IEXG" }

async function us() {
  const listed = new Map<string, { name: string, mic: string }>()
  const nasdaq = (await get("https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt")).split(/\r?\n/)
  for (const line of nasdaq.slice(1)) {
    const [symbol, name, , test, , , etf] = line.split("|")
    if (!symbol || symbol.startsWith("File Creation") || test === "Y" || etf === "Y") continue
    listed.set(symbol, { name, mic: "XNAS" })
  }
  const other = (await get("https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt")).split(/\r?\n/)
  for (const line of other.slice(1)) {
    const [symbol, name, exchange, , etf, , test] = line.split("|")
    if (!symbol || symbol.startsWith("File Creation") || test === "Y" || etf === "Y" || !US_MIC[exchange]) continue
    listed.set(symbol, { name, mic: US_MIC[exchange] })
  }
  console.log(`交易所清单 ${listed.size} 个非 ETF 代码`)
  const out: [string, string, string, string][] = []
  const seen = new Set<string>()
  const base = "https://stock.finance.sina.com.cn/usstock/api/jsonp.php/IO.XSRV2.CallbackList/US_CategoryService.getList"
  for (let page = 1; out.length < US_TOP_N && page < 400; page++) {
    const text = await get(`${base}?page=${page}&num=20&sort=mktcap&asc=0&market=&id=`, { referer: "https://finance.sina.com.cn/" })
    const body = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
    const data = (JSON.parse(body) as { data: { symbol: string, name: string, cname: string }[] }).data
    if (!data.length) break
    for (const r of data) {
      const hit = listed.get(r.symbol)
      // 权证、单位、优先股的代码带 W、U、R 之类后缀，交易所清单里的名字会写 Warrant / Unit / Rights / Preferred；
      // 「American Depositary Shares」是中概股等的 ADR，要收，只排除优先股类的 Depositary Shares
      if (!hit || seen.has(r.symbol)) continue
      const junk = /\b(?:Warrants?|Units?|Rights?|Preferred|Notes?)\b/i.test(hit.name) || (/Depositary Shares/i.test(hit.name) && !/American Depositary/i.test(hit.name))
      if (junk) continue
      seen.add(r.symbol)
      out.push([r.symbol, hit.mic, r.name.trim(), (r.cname ?? "").trim()])
    }
    await sleep(120)
  }
  console.log(`美股 ${out.length} 只`)
  write("us.json", out)
}

async function crypto() {
  const stable = new Set(["usdt", "usdc", "dai", "fdusd", "tusd", "usde", "usds", "pyusd", "busd", "usdd", "usdp", "gusd", "frax", "susd", "eurc", "usd1", "ethena-usde", "steth", "wsteth", "weth", "wbtc", "wbeth", "weeth", "cbbtc", "usdt0", "bsc-usd", "usdtb", "susde", "bfusd", "rlusd", "paxg", "xaut"])
  const gecko = JSON.parse(await get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${CRYPTO_TOP_N}&page=1`)) as { id: string, symbol: string, name: string, market_cap_rank: number }[]
  const info = JSON.parse(await get("https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT")) as { symbols: { symbol: string, baseAsset: string, quoteAsset: string, status: string }[] }
  const pairs = new Map(info.symbols.filter(s => s.quoteAsset === "USDT" && s.status === "TRADING").map(s => [s.baseAsset, s.symbol]))
  const out: [string, string, string, number][] = []
  const skipped: string[] = []
  for (const c of gecko) {
    const sym = c.symbol.toUpperCase()
    if (stable.has(c.symbol) || stable.has(c.id)) continue
    const pair = pairs.get(sym)
    if (!pair) {
      skipped.push(sym)
      continue
    }
    out.push([sym, `${pair}.BINANCE`, c.name, c.market_cap_rank])
  }
  console.log(`加密币 ${out.length} 个；市值前 ${CRYPTO_TOP_N} 里没有币安 USDT 现货对被略过：${skipped.join(",")}`)
  write("crypto.json", out)
}

const which = process.argv[2] ?? "all"
if (which === "ashare" || which === "all") await ashare()
if (which === "us" || which === "all") await us()
if (which === "crypto" || which === "all") await crypto()
