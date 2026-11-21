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

  it("rsshub 也经注入的出网函数抓取（同样的超时与体积上限），请求只落在内置 RSSHub 域名", async () => {
    const seen: string[] = []
    const items = await buildGetter({ kind: "rsshub", route: "/github/trending/daily", limit: 5 }, async (u) => {
      seen.push(u)
      return JSON.stringify({ title: "T", items: [{ id: "1", url: "https://g.example/1", title: "仓库一", date_published: "2026-11-21T10:00:00Z" }] })
    })()
    expect(seen).toEqual(["https://rsshub.rssforever.com/github/trending/daily?format=json&sorted=true&limit=5"])
    expect(items[0]).toMatchObject({ title: "仓库一", url: "https://g.example/1" })
  })

  it("rsshub 返回的不是 RSSHub 的 JSON 时给出明确错误，而不是 TypeError", async () => {
    await expect(buildGetter({ kind: "rsshub", route: "/x" }, async () => "<html>blocked</html>")()).rejects.toThrow("RSSHub 返回的不是 JSON Feed")
    await expect(buildGetter({ kind: "rsshub", route: "/x" }, async () => JSON.stringify({ error: "boom" }))()).rejects.toThrow("RSSHub 返回的不是 JSON Feed")
  })

  it("json 响应不是 JSON 时给出明确错误", async () => {
    const getter = buildGetter({ kind: "json", url: "https://a.com/x", itemsPath: "", fields: { title: "t", url: "u" } }, async () => "<html>")
    await expect(getter()).rejects.toThrow("响应不是合法的 JSON")
  })
})

describe("条目链接只留 http/https（出口统一过滤，丢弃整条）", () => {
  const evil = ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "file:///etc/passwd", "blob:https://a.example/x"]

  it("rss：link 不是 http/https 的条目被丢弃，相对链接按订阅地址补全", async () => {
    const xml = (links: string[]) => `<rss version="2.0"><channel><title>t</title>${links.map((l, i) => `<item><title>T${i}</title><link>${l.replace(/</g, "&lt;")}</link></item>`).join("")}</channel></rss>`
    const items = await buildGetter({ kind: "rss", url: "https://f.example/dir/feed.xml" }, async () => xml([...evil, "/rel/1", "https://ok.example/2"]))()
    expect(items.map(i => i.url)).toEqual(["https://f.example/rel/1", "https://ok.example/2"])
    expect(items.map(i => i.id)).toEqual(["https://f.example/rel/1", "https://ok.example/2"])
  })

  it("json：{路径} 模板拼出 javascript: 的丢弃；映射到 javascript: 字段的丢弃；id 不会带着坏链接进库", async () => {
    const spec = { kind: "json", url: "https://api.example/x", itemsPath: "", fields: { title: "t", url: "javascript:alert({id})" } } as const
    expect(await buildGetter(spec, async () => JSON.stringify([{ t: "A", id: 7 }]))()).toEqual([])
    const direct = { ...spec, fields: { title: "t", url: "u" } }
    const items = await buildGetter(direct, async () => JSON.stringify([...evil.map((u, i) => ({ t: `E${i}`, u })), { t: "OK", u: "https://ok.example/1" }]))()
    expect(items.map(i => i.title)).toEqual(["OK"])
  })

  it("rule：a@href 是 javascript: / data: 的丢弃", async () => {
    const html = `<ul>${evil.map((u, i) => `<li><a href="${u}">E${i}</a></li>`).join("")}<li><a href="/ok">OK</a></li></ul>`
    const items = await buildGetter({ kind: "rule", url: "https://s.example/", item: "li", fields: { title: "a", url: "a@href" } }, async () => html)()
    expect(items.map(i => i.title)).toEqual(["OK"])
    expect(items[0].url).toBe("https://s.example/ok")
  })

  it("rsshub：条目 url 同样过滤", async () => {
    const { sanitizeItems } = await import("#/registry/adapters")
    expect(sanitizeItems([{ id: "1", title: "a", url: "javascript:x" }, { id: "2", title: "b", url: "https://ok.example/" }], "https://hub.example/").map(i => i.id)).toEqual(["2"])
  })

  it("没有链接的条目保留，url 为空；id 用原 id，没有就用标题（快讯页的主要用法）", async () => {
    const html = `<ul><li><b class="t">快讯一</b><i class="id">n1</i></li><li><b class="t">快讯二</b></li></ul>`
    const spec = { kind: "rule", url: "https://s.example/flash", item: "li", fields: { title: "b.t", url: "a@href", id: "i.id" } } as const
    const first = await buildGetter(spec, async () => html)()
    expect(first).toEqual([
      { id: "n1", title: "快讯一", url: "", pubDate: undefined },
      { id: "快讯二", title: "快讯二", url: "", pubDate: undefined },
    ])
    expect((await buildGetter(spec, async () => html)()).map(i => i.id)).toEqual(first.map(i => i.id)) // id 稳定

    const json = await buildGetter({ kind: "json", url: "https://a.example/x", itemsPath: "", fields: { title: "t", url: "u" } }, async () => JSON.stringify([{ t: "无链接" }, { t: "有", u: "https://ok.example/1" }, { t: "坏", u: "javascript:x" }]))()
    expect(json.map(i => [i.id, i.url])).toEqual([["无链接", ""], ["https://ok.example/1", "https://ok.example/1"]])

    const rss = await buildGetter({ kind: "rss", url: "https://f.example/feed" }, async () => `<rss version="2.0"><channel><title>t</title><item><title>无链接条目</title></item></channel></rss>`)()
    expect(rss).toMatchObject([{ id: "无链接条目", title: "无链接条目", url: "" }])
  })

  it("preview 路径：整页都没有链接的 rule 源能解析出条目，不再 422", async () => {
    const { runPreview } = await import("#/registry/detect")
    const r = await runPreview({ kind: "rule", url: "https://s.example/", item: "li", fields: { title: "b", url: "a@href" } }, async () => "<ul><li><b>甲</b></li><li><b>乙</b></li></ul>", "n")
    expect(r.items.map(i => i.title)).toEqual(["甲", "乙"])
  })
})
