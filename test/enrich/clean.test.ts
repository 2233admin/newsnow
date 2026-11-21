import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { cleanTitle, decodeEntities, decodeGoogleNewsUrl, isGoogleNewsUrl, normalizeSpace, stripGoogleNewsSuffix } from "#/enrich/clean"
import { canonicalUrl } from "#/enrich/url"

/** 按旧格式（0x08 0x13 0x22 <长度> <网址>）构造一个 Google News 文章链接。 */
function legacyGoogleLink(target: string) {
  const body = Buffer.from(target, "utf8")
  const bytes = Buffer.concat([Buffer.from([0x08, 0x13, 0x22, body.length]), body, Buffer.from([0xD2, 0x01, 0x00])])
  return `https://news.google.com/rss/articles/${bytes.toString("base64url")}?oc=5`
}

// #6 的真实链接（2026-11-22 读自 Google News 的路透搜索 RSS）：新格式，解不出
const NEW_FORMAT = "https://news.google.com/rss/articles/CBMingFBVV95cUxNWXlDbDhlc09IVzVHS0dKcmt0cDVXd3ZRYUtWTkpDOU5IMlVfdUZsWWFqblljVXBPbG5pd1A3TTRDZkJQaFR3YXZHWHJETUk3OUhDLUw4b2dmZXZJYkhKRGdrMjFXcHJMYmt3MzRYU09OR0xkd3ZUbWNjMGhoRzhhR2NucjZaQjgyVGFqOXZ4Mm5vVUhWS3NQZHZvd0J1dw?oc=5"

describe("html 实体解码", () => {
  it("数字实体（十进制、十六进制）与常见命名实体", () => {
    expect(decodeEntities("Trump&#8217;s tariffs &amp; Fed &#x2014; &quot;ok&quot; &nbsp;&hellip;")).toBe("Trump’s tariffs & Fed — \"ok\"  …")
    expect(decodeEntities("诺斯洛普&#8226;格鲁门")).toBe("诺斯洛普•格鲁门")
  })

  it("双重转义再解一遍，但只多解一遍；本来没有实体的原样不动", () => {
    expect(decodeEntities("Don&amp;#8217;t")).toBe("Don’t")
    expect(decodeEntities("&amp;amp;amp;")).toBe("&amp;")
    expect(decodeEntities("AT&T 与 R&D 与 a < b")).toBe("AT&T 与 R&D 与 a < b")
  })

  it("空白归一：NBSP、全角空格、零宽字符、连续空白", () => {
    expect(normalizeSpace("  A  B　C​D \n E ")).toBe("A B CD E")
    expect(normalizeSpace("a​b")).toBe("ab")
  })
})

describe("google News 条目", () => {
  const url = "https://news.google.com/rss/articles/CBMi123?oc=5"

  it("去掉末尾的「 - 来源」，只去最后一段", () => {
    expect(stripGoogleNewsSuffix("NATO will defend every inch of Polish territory, Rutte says - Reuters")).toBe("NATO will defend every inch of Polish territory, Rutte says")
    expect(stripGoogleNewsSuffix("Fed holds rates - analysis - The Associated Press")).toBe("Fed holds rates - analysis")
  })

  it("标题太短、来源名太长、没有分隔时不去", () => {
    expect(stripGoogleNewsSuffix("A - B")).toBe("A - B")
    expect(stripGoogleNewsSuffix(`Some long headline here - ${"x".repeat(61)}`)).toContain("xxxx")
    expect(stripGoogleNewsSuffix("没有分隔的标题")).toBe("没有分隔的标题")
  })

  it("只对链接在 news.google.com 的条目去后缀；别的源标题里的「 - 」是正文", () => {
    expect(isGoogleNewsUrl(url)).toBe(true)
    expect(isGoogleNewsUrl("https://example.com/news.google.com")).toBe(false)
    expect(cleanTitle("Apple Inc - Q3 earnings preview - Reuters", url).title).toBe("Apple Inc - Q3 earnings preview")
    expect(cleanTitle("Apple Inc - Q3 earnings preview - Reuters", "https://techcrunch.com/a").title).toBe("Apple Inc - Q3 earnings preview - Reuters")
    expect(cleanTitle("Apple Inc - Q3 earnings preview - Reuters", null).title).toBe("Apple Inc - Q3 earnings preview - Reuters")
  })

  it("先解实体再去后缀（实体里的「 - 」不会被误判）", () => {
    expect(cleanTitle("Trump&#8217;s plan &amp; markets - Reuters", url).title).toBe("Trump’s plan & markets")
  })

  it("旧格式链接里解得出原文，新格式解不出（保留跳转链接）", () => {
    const target = "https://www.reuters.com/markets/us/stocks-rally-2026-11-21/"
    expect(decodeGoogleNewsUrl(legacyGoogleLink(target))).toBe(target)
    expect(cleanTitle("Stocks rally on Fed hopes - Reuters", legacyGoogleLink(target)).origUrl).toBe(target)
    expect(decodeGoogleNewsUrl(NEW_FORMAT)).toBeNull()
    expect(cleanTitle("NATO will defend every inch - Reuters", NEW_FORMAT).origUrl).toBeNull()
    for (const junk of ["https://example.com/rss/articles/CBMi", "https://news.google.com/foo", "not a url", "https://news.google.com/rss/articles/!!!"]) {
      expect(decodeGoogleNewsUrl(junk)).toBeNull()
    }
  })
})

describe("链接归一", () => {
  it("同一篇文章的不同写法归一后相同：大小写、www、协议、尾斜杠、追踪参数、fragment、参数顺序", () => {
    const same = [
      "https://www.Example.com/a/b/?utm_source=x&utm_medium=y&id=2&b=1#top",
      "http://example.com/a/b?b=1&id=2",
      "https://example.com/a/b/?id=2&b=1&fbclid=abc",
    ].map(canonicalUrl)
    expect(new Set(same).size).toBe(1)
    expect(same[0]).toBe("example.com/a/b?b=1&id=2")
  })

  it("首页、非 http、解析不了的是 null（不当成同一篇）", () => {
    for (const u of ["https://example.com", "https://example.com/", "https://example.com/?utm_source=x", "javascript:alert(1)", "ftp://x.example/a", "", null, undefined, "not a url"]) {
      expect(canonicalUrl(u as string)).toBeNull()
    }
  })

  it("不同的文章不会被并：路径或有意义的参数不同", () => {
    expect(canonicalUrl("https://a.com/p?id=1")).not.toBe(canonicalUrl("https://a.com/p?id=2"))
    expect(canonicalUrl("https://a.com/x")).not.toBe(canonicalUrl("https://a.com/y"))
    expect(canonicalUrl("https://a.com/x")).not.toBe(canonicalUrl("https://b.com/x"))
  })
})
