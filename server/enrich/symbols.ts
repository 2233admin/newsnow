/**
 * 标的识别（#2188）：从标题里认出 A 股、美股、加密币，输出 KATANAview 的品种 id「代码.场所」（决策记录 0044 / 0047）。
 *
 * 格式（读自 KATANAview 仓库 docs/architecture/adr/0047-instrument-master-and-codes.md、packages/market/src/catalog.ts 与
 * packages/service/src/exchanges/alpaca/symbols.ts，2026-11-22）：
 * - A 股：`600519.XSHG` 上交所、`000001.XSHE` 深交所、`920992.BJSE` 北交所（ISO 10383 MIC；BJSE 在 KATANAview 里标着「待核对」）。
 * - 美股：`AAPL.XNAS`，场所是上市交易所的 MIC（XNAS、XNYS、ARCX、XASE、BATS），不是成交场所；类别股用点（`BRK.B.XNYS`，按 alpaca/symbols.ts 的写法）。
 * - 加密币：没有 MIC，场所用交易所英文名大写，现货不加后缀：`BTCUSDT.BINANCE`。新闻里说「比特币」没有说哪家交易所，这里统一给币安的 USDT 现货对
 *   （词典里只收币安有 USDT 现货对的币，见 scripts/gen-symbol-dict.ts）；永续、别的交易所的对不给。
 *
 * 词典是数据（server/enrich/dict/*.json，scripts/gen-symbol-dict.ts 生成）加手写的别名与停用表（dict/aliases.json）。
 * 防误报的原则：宁漏勿错——行情单每行挂的标的错了比少一个更扎眼。
 * - 美股与加密币的**代码**（AAPL、BTC）只认强信号：`$AAPL`、括号里的代码（`(AAPL)`、`(NASDAQ: AAPL)`、`(AAPL.O)`）、`NASDAQ:` / `NYSE:` 前缀；
 *   加密币另认大写独立的 BTC / ETH 这类、`BTC/USDT`、`BTCUSDT` 写法（短的、像英语单词的除外，见 aliases.json 的 cryptoBareStop）。
 *   单独的 `ALL`、`IT`、`ON`、`A` 一律不认；括号里的单字母与宏观缩写（CPI、GDP、AI……）也不认。
 * - A 股代码只认：带 sh / sz / bj 前缀或 .SH / .SZ / .BJ 后缀的，或者整个包在括号里的六位数，并且要在词典里、场所与代码段对得上。
 * - 名称（中文简称、英文公司名）：中文名最长匹配、不重叠；两个字以下不收；停用表里的（泛化词、常用词）不收。
 *   英文公司名只认首字母大写的整词序列；单个词的英文名（Apple、Tesla）只认手写别名表里的，因为自动从公司全称派生出来的单个词
 *   （Target、Block、Visa、Ford、Gap……）太容易是普通英文词。
 */
import { decodeEntities } from "./clean"
import ashareData from "./dict/ashare.json"
import usData from "./dict/us.json"
import cryptoData from "./dict/crypto.json"
import aliasData from "./dict/aliases.json"

type AshareRow = [code: string, market: string, name: string]
type UsRow = [ticker: string, mic: string, name: string, cname: string]
type CryptoRow = [symbol: string, id: string, name: string, rank: number]

export interface Aliases {
  /** 美股：ticker → { cn: 中文常用名, en: 单词英文名 } */
  us: Record<string, { cn?: string[], en?: string[] }>
  /** 加密币：symbol → { cn, en } */
  crypto: Record<string, { cn?: string[], en?: string[] }>
  /** A 股：代码（六位）→ 额外的常用名 */
  ashare: Record<string, string[]>
  stop: {
    /** 不当成标的名称的中文串（泛化词、常用词）；小写比较 */
    cn: string[]
    /**
     * 三个字以上、本身是常用词 / 地名的 A 股简称（农产品、新世界、机器人……）：与两字简称同规则，标题里要有股票语境才认。
     * 来源：jieba 0.42.1 的 dict.txt（MIT，2026-11-22 读）里词频 ≥ 20 的 A 股简称（去 ST 前缀与末尾 A / B），
     * 扣掉人工挑出的、几乎只指公司的（中国移动、五粮液、招商银行等 43 个）。词频阈值 20 没有依据，是看着名单定的，待定。
     */
    ctx?: string[]
    /** 英文名里不当成标的的 */
    en: string[]
    /** 括号里 / 独立出现也不当成美股代码的缩写 */
    macro: string[]
    /** 加密币代码里不允许「裸」出现（没有 $、括号）的 */
    cryptoBare: string[]
  }
}

export interface DictData {
  ashare: AshareRow[]
  us: UsRow[]
  crypto: CryptoRow[]
  aliases: Aliases
}

export interface SymbolMatch {
  id: string
  /** 命中的信号：cashtag（$AAPL）、exchange（NASDAQ: AAPL）、paren（(AAPL)）、code（A 股代码）、pair（BTC/USDT）、ticker（裸的 BTC）、name（名称） */
  kind: "cashtag" | "exchange" | "paren" | "code" | "pair" | "ticker" | "name"
  text: string
  start: number
}

const VENUE_OF_MARKET: Record<string, string> = { sh: "XSHG", sz: "XSHE", bj: "BJSE" }
const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/
const A_NAME_PREFIX = /^(?:S\*ST|\*ST|SST|ST)(?=[\u3400-\u9FFF])/
const A_NAME_SUFFIX = /(?:-UW|-WD|-U|-W|-S)$/
const CN_SUFFIX = /(?:股份有限公司|有限公司|控股公司|控股集团|控股|集团公司|集团|公司)$/
const EN_SUFFIX = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "holdings", "holding", "group", "plc", "nv", "ag", "sa", "se", "lp", "llc", "the", "class", "ordinary", "shares", "common", "stock", "adr", "ads", "com"])
const EN_CONNECTOR = new Set(["of", "and", "the", "de", "for", "in"])
const MAX_EN_TOKENS = 5
/** 两个字的 A 股简称要求标题里有这些股票语境的词之一。待定：词表是照采集到的快讯手写的，没有按召回率调过。 */
const STOCK_CONTEXT = /股价|股票|个股|涨停|跌停|股东|股份|公告|增持|减持|回购|市值|收盘|开盘|板块|概念股|A股|科创板|创业板|北交所|上交所|深交所|龙头|主力资金|净流入|净流出|涨超|跌超|大涨|大跌|拉升|竞价|盘中|年报|季报|中报|业绩|研报|评级|目标价|\(\d{6}\)/

const norm = (s: string) => decodeEntities(s).normalize("NFKC")

/** 去掉公司全称尾巴后的英文名 token（小写）；全是尾巴词的返回空。 */
export function englishNameTokens(name: string): string[] {
  const tokens = norm(name).toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter(Boolean)
  while (tokens.length && EN_SUFFIX.has(tokens.at(-1)!)) tokens.pop()
  while (tokens.length && tokens[0] === "the") tokens.shift()
  return tokens
}

class Trie {
  private root = new Map<string, any>()
  add(word: string, value: string[]) {
    let node = this.root
    for (const ch of word) {
      let next = node.get(ch)
      if (!next) node.set(ch, (next = new Map()))
      node = next
    }
    node.set("", value)
  }

  /** 最左最长、互不重叠的命中。 */
  scan(text: string): { start: number, end: number, ids: string[] }[] {
    const out: { start: number, end: number, ids: string[] }[] = []
    const chars = [...text]
    let offsets: number[] | undefined
    let i = 0
    while (i < chars.length) {
      let node = this.root
      let best = -1
      let ids: string[] = []
      for (let j = i; j < chars.length; j++) {
        const next = node.get(chars[j])
        if (!next) break
        node = next
        if (node.has("")) {
          best = j + 1
          ids = node.get("")
        }
      }
      if (best > 0) {
        if (!offsets) {
          offsets = [0]
          for (const ch of chars) offsets.push(offsets.at(-1)! + ch.length)
        }
        out.push({ start: offsets[i], end: offsets[best], ids })
        i = best
      } else {
        i++
      }
    }
    return out
  }
}

export interface Matcher {
  match: (title: string) => SymbolMatch[]
  symbols: (title: string) => string[]
  stats: { ashareNames: number, usCnNames: number, usEnNames: number, usTickers: number, cryptoNames: number, ambiguousDropped: string[] }
}

export function createMatcher(data: DictData): Matcher {
  const { aliases } = data
  const ctxCn = new Set((aliases.stop.ctx ?? []).map(s => norm(s).toLowerCase()))
  const stopCn = new Set(aliases.stop.cn.map(s => norm(s).toLowerCase()))
  const stopEn = new Set(aliases.stop.en.map(s => norm(s).toLowerCase()))
  const macro = new Set(aliases.stop.macro)
  const cryptoBareStop = new Set(aliases.stop.cryptoBare)
  const ambiguousDropped: string[] = []

  // ---- 名称 → 品种 id（中文名与带中文的名称，进字典树）
  const cnNames = new Map<string, string[]>()
  const addCn = (name: string, id: string) => {
    const key = norm(name).toLowerCase().trim()
    if (key.length < 2 || stopCn.has(key)) return
    const list = cnNames.get(key)
    if (!list) cnNames.set(key, [id])
    else if (!list.includes(id)) list.push(id)
  }

  // ---- A 股
  const ashareById = new Map<string, string>()
  const ashareByCode = new Map<string, { id: string, market: string }>()
  let ashareNames = 0
  for (const [code, market, name] of data.ashare) {
    const id = `${code}.${VENUE_OF_MARKET[market]}`
    ashareById.set(id, name)
    ashareByCode.set(code, { id, market })
    const bare = norm(name).replace(A_NAME_PREFIX, "").replace(A_NAME_SUFFIX, "")
    addCn(bare, id)
    // 万科A → 万科
    if (/[AB]$/.test(bare) && bare.length >= 3) addCn(bare.slice(0, -1), id)
    for (const extra of aliases.ashare[code] ?? []) addCn(extra, id)
    ashareNames++
  }

  // ---- 美股
  const usByTicker = new Map<string, string>()
  const enNames = new Map<string, string[]>()
  const addEn = (tokens: string[], id: string) => {
    const key = tokens.join(" ")
    if (!key || stopEn.has(key)) return
    const list = enNames.get(key)
    if (!list) enNames.set(key, [id])
    else if (!list.includes(id)) list.push(id)
  }
  let maxEnTokens = 1
  for (const [ticker, mic, name, cname] of data.us) {
    const id = `${ticker}.${mic}`
    if (!usByTicker.has(ticker)) usByTicker.set(ticker, id)
    const cn = norm(cname)
    if (CJK.test(cn)) {
      addCn(cn.replace(CN_SUFFIX, ""), id)
      addCn(cn, id)
    }
    const tokens = englishNameTokens(name)
    // 单个词的英文名不自动收（Target、Block、Visa……），只收两个词以上的（Advanced Micro Devices、Palo Alto Networks）
    if (tokens.length >= 2) {
      addEn(tokens, id)
      maxEnTokens = Math.max(maxEnTokens, tokens.length)
    }
    const alias = aliases.us[ticker]
    for (const c of alias?.cn ?? []) addCn(c, id)
    for (const e of alias?.en ?? []) {
      const t = englishNameTokens(e)
      addEn(t, id)
      maxEnTokens = Math.max(maxEnTokens, t.length)
    }
  }
  maxEnTokens = Math.min(maxEnTokens, MAX_EN_TOKENS)

  // ---- 加密币
  const cryptoBySymbol = new Map<string, string>()
  for (const [symbol, id, name] of data.crypto) {
    cryptoBySymbol.set(symbol, id)
    const alias = aliases.crypto[symbol]
    for (const c of alias?.cn ?? []) addCn(c, id)
    for (const e of alias?.en ?? []) {
      const t = englishNameTokens(e)
      addEn(t, id)
      maxEnTokens = Math.max(maxEnTokens, Math.min(t.length, MAX_EN_TOKENS))
    }
    // 币的英文全称（Bitcoin Cash、Shiba Inu）两个词以上才自动收
    const tokens = englishNameTokens(name)
    if (tokens.length >= 2) addEn(tokens, id)
  }

  // ---- 多个品种共用一个名字：同一家美国公司的几个股份类别（GOOG / GOOGL、BRK.A / BRK.B，词典按市值从大到小排）取排在前面的；
  // 跨市场或不同公司同名（惠而浦既是 A 股也是美股）取谁都没有依据，丢掉并记下
  const isUs = (id: string) => !ashareById.has(id) && !id.endsWith(".BINANCE")
  const pick = (name: string, ids: string[]): string | undefined => {
    if (ids.length === 1) return ids[0]
    if (ids.every(isUs)) return ids[0]
    ambiguousDropped.push(`${name}=${ids.join("|")}`)
    return undefined
  }
  const trie = new Trie()
  for (const [name, ids] of cnNames) {
    const id = pick(name, ids)
    if (id) trie.add(name, [id])
  }
  const enFinal = new Map<string, string>()
  for (const [name, ids] of enNames) {
    const id = pick(name, ids)
    if (id) enFinal.set(name, id)
  }

  const A_CODE = /(?<![0-9A-Z])(?:(sh|sz|bj)\s?)?(\d{6})(?:\.(sh|sz|bj|ss))?(?![0-9A-Z])/gi
  const CASHTAG = /\$([A-Z]{1,5}(?:[.-][A-Z])?)(?![A-Za-z0-9])/g
  const EXCHANGE = /(?:NASDAQ|NYSE(?:\s?(?:ARCA|AMERICAN|MKT))?|AMEX|纳斯达克|纽交所|纽约证券交易所)\s*[:：]\s*([A-Z]{1,5}(?:[.-][A-Z])?)(?![A-Za-z0-9])/g
  const RIC = /[(（]\s*([A-Z]{1,5})\.(?:OQ|PK|[ONKAP])\s*[)）]/g
  const PAREN = /[(（]\s*([A-Z]{1,5}(?:[.-][A-Z])?)\s*[)）]/g
  const PAIR = /(?<![A-Za-z0-9])([A-Z]{2,10})\s?[/-]?\s?(?:USDT|USDC|USD|BUSD|PERP)(?![A-Za-z0-9])/g
  const BARE = /(?<![A-Za-z0-9$])([A-Z]{3,6})(?![A-Za-z0-9])/g

  function match(title: string): SymbolMatch[] {
    const text = norm(title)
    const out: SymbolMatch[] = []
    const add = (id: string | undefined, kind: SymbolMatch["kind"], at: string, start: number) => {
      if (id) out.push({ id, kind, text: at, start })
    }
    const usOrCrypto = (sym: string, allowCrypto = true) => usByTicker.get(sym) ?? (allowCrypto ? cryptoBySymbol.get(sym) : undefined)

    for (const m of text.matchAll(CASHTAG)) add(usOrCrypto(m[1]), "cashtag", m[0], m.index!)
    for (const m of text.matchAll(EXCHANGE)) add(usByTicker.get(m[1]), "exchange", m[0], m.index!)
    for (const m of text.matchAll(RIC)) {
      if (!macro.has(m[1])) add(usByTicker.get(m[1]), "paren", m[0], m.index!)
    }
    for (const m of text.matchAll(PAREN)) {
      const sym = m[1]
      // 括号里的单字母多半是列表序号（(A)、(C)）；宏观缩写不算
      if (sym.length < 2 || macro.has(sym)) continue
      add(usOrCrypto(sym), "paren", m[0], m.index!)
    }
    for (const m of text.matchAll(PAIR)) add(cryptoBySymbol.get(m[1]), "pair", m[0], m.index!)
    for (const m of text.matchAll(BARE)) {
      if (cryptoBareStop.has(m[1])) continue
      add(cryptoBySymbol.get(m[1]), "ticker", m[0], m.index!)
    }
    for (const m of text.matchAll(A_CODE)) {
      const [raw, prefix, code, suffix] = m
      const entry = ashareByCode.get(code)
      if (!entry) continue
      const at = m.index!
      const wrapped = /[(（[【]\s*$/.test(text.slice(Math.max(0, at - 3), at)) && /^\s*[)）\]】]/.test(text.slice(at + raw.length, at + raw.length + 3))
      const labelled = /代码\s*(?:[:：]\s*)?$/.test(text.slice(Math.max(0, at - 6), at))
      const venue = (prefix ?? suffix)?.toLowerCase()
      if (venue) {
        if ((venue === "ss" ? "sh" : venue) !== entry.market) continue
      } else if (!wrapped && !labelled) {
        continue
      } else if (code === "000001") {
        // 000001 既是平安银行也是上证指数，没有场所标记时不认
        continue
      }
      add(entry.id, "code", raw, at)
    }
    const gated = STOCK_CONTEXT.test(text)
    for (const hit of trie.scan(text.toLowerCase())) {
      const id = hit.ids[0]
      // 两个字的 A 股简称（发展、标准、动力……）太容易是普通词：标题里要同时有股票语境的词才认
      if (!gated && ashareById.has(id) && (hit.end - hit.start <= 2 || ctxCn.has(text.slice(hit.start, hit.end).toLowerCase()))) continue
      add(id, "name", text.slice(hit.start, hit.end), hit.start)
    }
    // 英文公司名：整词序列，每个词首字母大写（连接词除外）
    const words = [...text.matchAll(/[A-Z0-9]+/gi)].map(m => ({ w: m[0], at: m.index! }))
    for (let i = 0; i < words.length; i++) {
      for (let n = Math.min(maxEnTokens, words.length - i); n >= 1; n--) {
        const slice = words.slice(i, i + n)
        const capitalised = slice.every((x, k) => /^[A-Z0-9]/.test(x.w) || (k > 0 && k < n - 1 && EN_CONNECTOR.has(x.w)))
        if (!capitalised) continue
        // 词之间只能隔空格、连字符、点、&（Coca-Cola、Johnson & Johnson），不能隔着逗号和句号
        const span = text.slice(slice[0].at, slice[n - 1].at + slice[n - 1].w.length)
        if (!/^[A-Za-z0-9]+(?:(?:[\s\-.&]|'s)+[A-Za-z0-9]+)*$/.test(span)) continue
        const id = enFinal.get(slice.map(x => x.w.toLowerCase()).join(" "))
        if (id) {
          add(id, "name", span, slice[0].at)
          i += n - 1
          break
        }
      }
    }
    return out.sort((a, b) => a.start - b.start)
  }

  return {
    match,
    symbols(title) {
      const seen = new Set<string>()
      for (const m of match(title)) seen.add(m.id)
      return [...seen]
    },
    stats: {
      ashareNames,
      usCnNames: [...cnNames.keys()].length,
      usEnNames: enFinal.size,
      usTickers: usByTicker.size,
      cryptoNames: cryptoBySymbol.size,
      ambiguousDropped,
    },
  }
}

let shared: Matcher | undefined

/** 进程内共用一份（建字典树要几十毫秒，只建一次）。 */
export function getMatcher(): Matcher {
  shared ??= createMatcher({
    ashare: ashareData as AshareRow[],
    us: usData as UsRow[],
    crypto: cryptoData as CryptoRow[],
    aliases: aliasData as Aliases,
  })
  return shared
}

export function extractSymbols(title: string): string[] {
  return getMatcher().symbols(title)
}

/** 品种 id 的格式：代码.场所，场所是 3 到 12 个大写字母（MIC 四位，加密交易所英文名更长）。 */
export const SYMBOL_ID = /^[A-Z0-9][A-Z0-9.-]{0,14}\.[A-Z]{3,12}$/
