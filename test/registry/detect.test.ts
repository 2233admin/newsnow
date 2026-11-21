import { describe, expect, it, vi } from "vitest"
import { FEED_ITEMS, RSS } from "./helpers"
import { detect, discoverFeedUrl, guessJsonSpec } from "#/registry/detect"
import { InputError } from "#/registry/spec"
import { RSSHUB_BASE } from "#/utils/source"

// RSSHub 适配器经 myFetch 出网（固定域名）；这里替换掉，不连网
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock("#/utils/fetch", () => ({ myFetch: fetchMock }))

function deps(pages: Record<string, string>) {
  return {
    rsshubBase: RSSHUB_BASE,
    fetchText: async (u: string) => {
      if (u in pages) return pages[u]
      throw new Error(`no page ${u}`)
    },
  }
}

describe("detect", () => {
  it("识别 RSS：取标题、取标题、预览 5 条并给出总数", async () => {
    const r = await detect("https://a.example/feed", deps({ "https://a.example/feed": RSS(FEED_ITEMS, "示例 Feed") }))
    expect(r.spec).toEqual({ kind: "rss", url: "https://a.example/feed" })
    expect(r.name).toBe("示例 Feed")
    expect(r.items).toHaveLength(5)
    expect(r.total).toBe(8)
  })

  it("atom 也认", async () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>t1</title><link href="https://a.example/1"/><id>1</id><updated>2026-11-21T10:00:00Z</updated></entry></feed>`
    const r = await detect("https://a.example/atom", deps({ "https://a.example/atom": atom }))
    expect(r.spec.kind).toBe("rss")
    expect(r.items[0].title).toBe("t1")
  })

  it("识别 JSON：猜出条目数组与字段映射", async () => {
    const body = JSON.stringify({ code: 0, data: { items: [
      { id: 1, title: "甲", url: "https://a.example/1", created_at: 1763719200 },
      { id: 2, title: "乙", url: "https://a.example/2", created_at: 1763719300 },
    ] } })
    const r = await detect("https://a.example/api", deps({ "https://a.example/api": body }))
    expect(r.spec).toEqual({ kind: "json", url: "https://a.example/api", itemsPath: "data.items", fields: { title: "title", url: "url", id: "id", pubDate: "created_at" } })
    expect(r.items.map(i => i.title)).toEqual(["甲", "乙"])
  })

  it("网页里声明了 RSS：按声明的地址识别；没声明：说明要手写选择器", async () => {
    const withLink = `<html><head><title>站点</title><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head><body/></html>`
    const r = await detect("https://a.example/", deps({ "https://a.example/": withLink, "https://a.example/rss.xml": RSS(FEED_ITEMS, "站点 RSS") }))
    expect(r.spec).toEqual({ kind: "rss", url: "https://a.example/rss.xml" })
    expect(r.name).toBe("站点 RSS")
    await expect(detect("https://b.example/", deps({ "https://b.example/": "<html><body>hi</body></html>" }))).rejects.toThrow(/rule/)
  })

  it("/路由 与 rsshub:// 走 RSSHub，请求落在内置的 RSSHub 域名；跳出域名的路由拒绝", async () => {
    fetchMock.mockResolvedValue({ title: "T", items: [{ id: "1", url: "https://g.example/1", title: "仓库一", date_published: "2026-11-21T10:00:00Z" }] })
    const r = await detect("rsshub://github/trending/daily", deps({}))
    expect(r.spec).toEqual({ kind: "rsshub", route: "/github/trending/daily" })
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${RSSHUB_BASE}/github/trending/daily?format=json&sorted=true`)
    expect(r.items[0].title).toBe("仓库一")
    await expect(detect("//evil.com/x", deps({}))).rejects.toThrow(InputError)
    await expect(detect("rsshub://evil.com/x", deps({}))).resolves.toBeTruthy() // 路由 /evil.com/x 仍在 RSSHub 域名下
    expect(String(fetchMock.mock.calls[1][0]).startsWith(`${RSSHUB_BASE}/evil.com/x`)).toBe(true)
  })

  it("猜不出字段时报错", () => {
    expect(() => guessJsonSpec("https://a.example", { a: 1 })).toThrow(/找不到条目数组/)
    expect(() => guessJsonSpec("https://a.example", [{ x: 1 }])).toThrow(/猜不出/)
  })

  it("识别 Algolia 风格的 objectID 作为 id", () => {
    const spec = guessJsonSpec("https://a.example", { hits: [{ objectID: "1", title: "t", url: "https://a.example/1", created_at: "2026-11-21T10:00:00Z" }] })
    expect(spec.fields).toEqual({ title: "title", url: "url", id: "objectID", pubDate: "created_at" })
  })

  it("discoverFeedUrl 补全相对地址", () => {
    expect(discoverFeedUrl(`<link rel="alternate" type="application/atom+xml" href="feed.atom">`, "https://a.example/blog/")).toBe("https://a.example/blog/feed.atom")
    expect(discoverFeedUrl(`<link rel="stylesheet" href="x.css">`, "https://a.example/")).toBeUndefined()
  })
})
