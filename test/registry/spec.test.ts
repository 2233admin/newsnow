import { describe, expect, it } from "vitest"
import { RSSHUB_BASE } from "#/utils/source"
import { InputError, assertSlug, checkRsshubRoute, normalizeInterval, normalizeSpec, slugify, toSourceId } from "#/registry/spec"

describe("normalizeSpec", () => {
  it("四种 kind 都规范化，多余字段丢掉", () => {
    expect(normalizeSpec({ kind: "rss", url: "https://a.com/feed", junk: 1 }, RSSHUB_BASE)).toEqual({ kind: "rss", url: "https://a.com/feed" })
    expect(normalizeSpec({ kind: "rsshub", route: "/github/trending/daily", limit: 10 }, RSSHUB_BASE)).toEqual({ kind: "rsshub", route: "/github/trending/daily", limit: 10 })
    expect(normalizeSpec({ kind: "json", url: "https://a.com/api", itemsPath: "data.list", fields: { title: "t", url: "u", id: "", x: 1 } }, RSSHUB_BASE))
      .toEqual({ kind: "json", url: "https://a.com/api", itemsPath: "data.list", fields: { title: "t", url: "u" } })
    expect(normalizeSpec({ kind: "rule", url: "https://a.com/", item: "li", fields: { title: "a", url: "a@href" } }, RSSHUB_BASE))
      .toEqual({ kind: "rule", url: "https://a.com/", item: "li", fields: { title: "a", url: "a@href" } })
  })

  it("只许 http/https，不许账号密码，缺字段报错", () => {
    for (const url of ["file:///etc/passwd", "ftp://a.com/x", "javascript:alert(1)", "https://u:p@a.com/", "not a url"])
      expect(() => normalizeSpec({ kind: "rss", url }, RSSHUB_BASE)).toThrow(InputError)
    expect(() => normalizeSpec({ kind: "json", url: "https://a.com" }, RSSHUB_BASE)).toThrow(InputError)
    expect(() => normalizeSpec({ kind: "nope" }, RSSHUB_BASE)).toThrow(InputError)
    expect(() => normalizeSpec(null, RSSHUB_BASE)).toThrow(InputError)
  })

  it("限制 RSSHub 路由不能借 new URL(route, base) 跳到别的域名", () => {
    for (const route of ["//evil.com/x", "http://evil.com/x", "/\\evil.com", "x/y", "/a b", "/a\nb"])
      expect(() => checkRsshubRoute(route, RSSHUB_BASE), route).toThrow(InputError)
    expect(checkRsshubRoute("/github/issue/a/b?limit=5", RSSHUB_BASE)).toBe("/github/issue/a/b?limit=5")
  })
})

describe("间隔、slug", () => {
  it("间隔在 2 分钟到 24 小时之间", () => {
    expect(normalizeInterval(undefined)).toBe(600_000)
    expect(normalizeInterval(120_000)).toBe(120_000)
    for (const v of [119_999, 86_400_001, 1.5, "600000", Number.NaN]) expect(() => normalizeInterval(v)).toThrow(InputError)
  })

  it("slug 规则与保留名；id 带命名空间", () => {
    expect(assertSlug("my-feed-2")).toBe("my-feed-2")
    for (const s of ["", "-a", "A", "a_b", "a:b", "opml", "preview", "a".repeat(49), 5]) expect(() => assertSlug(s)).toThrow(InputError)
    expect(toSourceId("x")).toBe("user:x")
    expect(slugify("Hacker News!", "x")).toBe("hacker-news")
    expect(slugify("华尔街见闻", "wallstreetcn.com")).toBe("wallstreetcn-com")
    expect(slugify("华尔街见闻")).toBe("source")
  })
})
