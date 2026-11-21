/**
 * 去重键与相似度（#2188）。只有确定性规则，没有语义模型：
 *
 * 1. 链接相同（见 url.ts 的归一）。
 * 2. 标题归一后相同：先去掉通讯社前缀与后缀，NFKC 归一并小写，只留字母与数字（标点、空白、括号全删），所以「【快讯】」「，」「 - 」这类差异不影响。
 * 3. 标题高度相似：字符二元组的 Dice 系数 ≥ SIMILARITY，**且**两个标题里的数字序列完全一样，**且**两边的有效字数都不少于 MIN_FUZZY_LENGTH，
 *    **且**在 FUZZY_WINDOW_MS 之内。数字必须一样是因为财经快讯里套话极多（「美元指数涨0.3%」「某公司发布三季报」），只差几个数字或公司名的是两件事。
 *
 * 阈值与窗口的依据见各常量；它们都是待定的数，用 scripts/enrich-eval.ts 在采集到的真库上量过（PR 里贴了量法与结果）。
 */

/** 归一后标题至少多少个字（字母、数字、汉字各算一个）才参与按标题合并。更短的（「早报」「美股收盘」）太容易撞车。待定：10 约相当于一句短快讯。 */
export const MIN_KEY_LENGTH = 10
/** 参与相似度比较的最短有效字数。待定。 */
export const MIN_FUZZY_LENGTH = 16
/** 二元组 Dice 系数下限。待定：见 PR 里的量法。 */
export const SIMILARITY = 0.9
/** 按标题合并（精确与相似）只在这个时间窗内找：同一事件的转载集中在发生后一两天。更长会把定期重复的固定标题并成一组，更短会漏掉隔夜转载。待定。 */
export const TITLE_WINDOW_MS = 48 * 3600_000
/** 相似度比较只与最近这么久的条目比，每批新条目都要扫一遍这个窗里的所有标题，所以窗比精确匹配的小得多。待定。 */
export const FUZZY_WINDOW_MS = 6 * 3600_000
/** 按链接合并的窗口：同一个链接再次出现多半是源站把老稿重新排上来，超过这个窗就不并了。待定。 */
export const URL_WINDOW_MS = 7 * 24 * 3600_000

// 通讯社开头：「财联社11月21日电，」「金十数据11月21日讯：」「新华社北京11月21日电」
const AGENCY_PREFIX = /^[\u3400-\u9FFFA-Z]{2,8}[\u3400-\u9FFF]{0,4}\d{1,2}月\d{1,2}日(?:电|讯|消息)[，,:：\s]*/i
// 末尾的来源括号：「（新华社）」「(财联社)」「（来源：证券时报）」
const SOURCE_SUFFIX = /[（(](?:来源[:：])?[^（()）]{1,8}(?:[社网报台讯]|新闻|消息|数据)[）)]\s*$/

export function titleKey(clean: string): string {
  let t = clean.normalize("NFKC")
  t = t.replace(AGENCY_PREFIX, "").replace(SOURCE_SUFFIX, "")
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

function bigrams(key: string): Map<string, number> {
  const out = new Map<string, number>()
  const chars = [...key]
  for (let i = 0; i + 1 < chars.length; i++) {
    const g = chars[i] + chars[i + 1]
    out.set(g, (out.get(g) ?? 0) + 1)
  }
  return out
}

const numbersOf = (key: string) => (key.match(/\d+/g) ?? []).join(",")

export interface KeyInfo {
  key: string
  length: number
  grams: Map<string, number>
  numbers: string
}

export function keyInfo(key: string): KeyInfo {
  return { key, length: [...key].length, grams: bigrams(key), numbers: numbersOf(key) }
}

/** 二元组多重集的 Dice 系数：2·|A∩B| / (|A|+|B|)。 */
export function dice(a: KeyInfo, b: KeyInfo): number {
  let inter = 0
  let total = 0
  for (const n of a.grams.values()) total += n
  for (const n of b.grams.values()) total += n
  if (!total) return 0
  const [small, large] = a.grams.size <= b.grams.size ? [a.grams, b.grams] : [b.grams, a.grams]
  for (const [g, n] of small) inter += Math.min(n, large.get(g) ?? 0)
  return 2 * inter / total
}

export function similar(a: KeyInfo, b: KeyInfo): boolean {
  if (a.length < MIN_FUZZY_LENGTH || b.length < MIN_FUZZY_LENGTH) return false
  if (a.numbers !== b.numbers) return false
  if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.7) return false
  return dice(a, b) >= SIMILARITY
}
