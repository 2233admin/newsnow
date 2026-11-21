import { Buffer } from "node:buffer"
import { decodeHTML } from "entities"

/**
 * 标题清洗（#2188）：只产出另存的 clean_title，不改库里的原始标题。
 *
 * 1. 解码 HTML 实体（`&#8217;`、`&amp;`、`&nbsp;`……）。共享的 rss2json 不解码（#6 实测 TechCrunch 标题里有 `&#8217;`）。
 *    用 entities 包的完整 HTML 实体表。一次解不开的双重转义（`&amp;#8217;`，个别 RSS 生成器会这样）再解一次，最多两遍：
 *    第一遍之后还像实体才解第二遍，所以正文里本来就写着 `&amp;` 的标题只会少一层转义，不会被反复吃掉。
 * 2. 空白归一：NBSP、全角空格、零宽字符、连续空白合成一个空格，去首尾。
 * 3. Google News 条目（链接在 news.google.com）：标题末尾恒有「 - 来源」（路透、美联社预置源，#6 的发现），去掉。
 *    只对 Google News 条目去后缀：别的源标题里的「 - 」可能是正文（`A - B 对决`），不能一概去。
 */

const STILL_ENTITY = /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i
// 零宽空格、零宽连接符、BOM、软连字符
// oxlint-disable-next-line no-misleading-character-class -- 字符类里就是要列这几个不可见字符
const INVISIBLE = /[\u200B-\u200D⁠\uFEFF­]/g

export function decodeEntities(text: string): string {
  let out = decodeHTML(text)
  if (STILL_ENTITY.test(out)) out = decodeHTML(out)
  return out
}

export function normalizeSpace(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim()
}

export function isGoogleNewsUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    return new URL(url).hostname === "news.google.com"
  } catch {
    return false
  }
}

/**
 * 去掉 Google News 追加的「 - 来源」后缀：取最后一个「 - 」（前后各一个空格）之后的部分，来源名不超过 60 个字符、
 * 且去掉后标题还剩至少 8 个字符才去（标题本身就是「A - B」且很短时，宁可留着）。
 * 来源名里自己带「 - 」的（如 `Reuters - Business`）只去最后一段，会留下一截；没见到过，不处理。
 */
export function stripGoogleNewsSuffix(title: string): string {
  const i = title.lastIndexOf(" - ")
  if (i < 0) return title
  const suffix = title.slice(i + 3).trim()
  const head = title.slice(0, i).trim()
  if (!suffix || suffix.length > 60 || head.length < 8) return title
  return head
}

/**
 * Google News 的旧格式文章链接把原文网址直接放在 base64 里：`/rss/articles/CBMi<base64url(0x08 0x13 0x22 <长度> <网址>…)>`。
 * 2024 年之后的新格式（`CBMi` 后面是 `AU_yqL…`，实测 2026-11-22 路透源 100 条全是这种）里没有网址，要向 Google 发请求才解得出，
 * 写库时同步跑不合适（每条两次出网），所以解不出的保留跳转链接，返回 null。
 * 旧格式的解法按公开的逆向说明写，**没有真实的旧格式链接验证过**，只用按同样格式构造的链接测了。
 */
export function decodeGoogleNewsUrl(url: string): string | null {
  let id: string
  try {
    const u = new URL(url)
    if (u.hostname !== "news.google.com") return null
    const m = /^\/(?:rss\/)?(?:articles|read)\/([\w-]+)$/.exec(u.pathname)
    if (!m) return null
    id = m[1]
  } catch {
    return null
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(id, "base64url")
  } catch {
    return null
  }
  // 0x08 0x13 0x22 <varint 长度> <网址>
  if (bytes.length < 6 || bytes[0] !== 0x08 || bytes[2] !== 0x22) return null
  let pos = 3
  let length = 0
  for (let shift = 0; pos < bytes.length; shift += 7) {
    const b = bytes[pos++]
    length |= (b & 0x7F) << shift
    if (!(b & 0x80)) break
  }
  const text = bytes.subarray(pos, pos + length).toString("utf8")
  if (!/^https?:\/\//.test(text) || text.startsWith("AU_yq")) return null
  try {
    return new URL(text).toString()
  } catch {
    return null
  }
}

export interface Cleaned {
  title: string
  /** 解出的原文链接（目前只有 Google News 旧格式链接）；没有就是 null，调用方继续用原链接 */
  origUrl: string | null
}

export function cleanTitle(title: string, url: string | null | undefined): Cleaned {
  let t = normalizeSpace(decodeEntities(title))
  let origUrl: string | null = null
  if (isGoogleNewsUrl(url)) {
    t = normalizeSpace(stripGoogleNewsSuffix(t))
    origUrl = decodeGoogleNewsUrl(url!)
  }
  return { title: t, origUrl }
}
