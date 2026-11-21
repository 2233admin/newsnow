import { describe, expect, it } from "vitest"
import { FEED_ITEMS, RSS } from "./helpers"
import { buildGetter, getPath, mapJson, mapRule, normalizeDate } from "#/registry/adapters"

describe("getPath", () => {
  it("点路径与数组下标；不读原型链", () => {
    const o = { a: { b: [{ c: 1 }, { c: 2 }] } }
    expect(getPath(o, "a.b.1.c")).toBe(2)
    expect(getPath(o, "a.x.c")).toBeUndefined()
    expect(getPath(o, "__proto__")).toBeUndefined()
    expect(getPath(o, "a.constructor")).toBeUndefined()
    expect(getPath(o, "")).toBe(o)
  })
})

describe("normalizeDate", () => {
  it("纯数字：小于 1e11 当秒，否则当毫秒；字符串原样", () => {
    expect(normalizeDate("1763719200")).toBe(1763719200000)
    expect(normalizeDate("1763719200123")).toBe(1763719200123)
    expect(normalizeDate("2026-11-21T10:00:00Z")).toBe("2026-11-21T10:00:00Z")
    expect(normalizeDate("")).toBeUndefined()
  })
})

describe("mapJson", () => {
  const spec = { kind: "json", url: "https://api.example.com/v1/news", itemsPath: "data.list", fields: { title: "headline", url: "link", id: "uid", pubDate: "ts" } } as const

  it("按映射取字段；相对链接补全；没有标题的丢掉；缺 id 退回链接", () => {
    const body = { data: { list: [
      { headline: "A", link: "/n/1", uid: 7, ts: 1763719200 },
      { headline: "", link: "/n/2" },
      { headline: "C", link: "https://other.com/3" },
      "junk",
    ] } }
    expect(mapJson(body, spec)).toEqual([
      { id: "7", title: "A", url: "https://api.example.com/n/1", pubDate: 1763719200000 },
      { id: "https://other.com/3", title: "C", url: "https://other.com/3", pubDate: undefined },
    ])
  })

  it("url 字段支持 {路径} 模板", () => {
    const items = mapJson([{ id: 42, title: "T" }], { ...spec, itemsPath: "", fields: { title: "title", url: "https://hn.example/item?id={id}" } })
    expect(items[0].url).toBe("https://hn.example/item?id=42")
  })

  it("itemsPath 没指向数组时报错", () => {
    expect(() => mapJson({ data: {} }, spec)).toThrow(/没有指向数组/)
  })
})

describe("mapRule", () => {
  const html = `<ul class="news">
    <li><a class="t" href="/a/1">  第一条
      新闻 </a><time datetime="2026-11-21T10:00:00Z">今天</time></li>
    <li><a class="t" href="https://x.com/2">第二条</a></li>
    <li><span>没有链接</span></li>
  </ul>`
  const spec = { kind: "rule", url: "https://news.example.com/list", item: "ul.news li", fields: { title: "a.t", url: "a.t@href", pubDate: "time@datetime" } } as const

  it("选择器 + 属性取值；文本压空白；相对链接补全；没标题的丢掉", () => {
    expect(mapRule(html, spec)).toEqual([
      { id: "https://news.example.com/a/1", title: "第一条 新闻", url: "https://news.example.com/a/1", pubDate: "2026-11-21T10:00:00Z" },
      { id: "https://x.com/2", title: "第二条", url: "https://x.com/2", pubDate: undefined },
    ])
  })

  it("省略选择器取条目元素自己的属性", () => {
    const items = mapRule("<div><a href='/p/1' title='标题一'>x</a></div>", { kind: "rule", url: "https://s.com/", item: "a", fields: { title: "@title", url: "@href" } })
    expect(items).toEqual([{ id: "https://s.com/p/1", title: "标题一", url: "https://s.com/p/1", pubDate: undefined }])
  })
})

describe("buildGetter", () => {
  it("rss 经注入的出网函数抓取（复用 defineRSSSource）", async () => {
    const seen: string[] = []
    const getter = buildGetter({ kind: "rss", url: "https://f.example/feed" }, async (u) => {
      seen.push(u)
      return RSS(FEED_ITEMS)
    })
    const items = await getter()
    expect(seen).toEqual(["https://f.example/feed"])
    expect(items).toHaveLength(8)
    expect(items[0]).toMatchObject({ title: "新闻 0", url: "https://example.com/p/0", id: "https://example.com/p/0" })
  })

  it("json 响应不是 JSON 时给出明确错误", async () => {
    const getter = buildGetter({ kind: "json", url: "https://a.com/x", itemsPath: "", fields: { title: "t", url: "u" } }, async () => "<html>")
    await expect(getter()).rejects.toThrow("响应不是合法的 JSON")
  })
})
