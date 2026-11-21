import { describe, expect, it } from "vitest"
import { FEED_ITEMS, RSS, setupWorld } from "./helpers"
import { InputError } from "#/registry/spec"
import { exportOpml, parseOpml } from "#/registry/opml"

const FEED = "https://feed.example/rss"
const API = "https://api.example/news"
const PAGE = "https://page.example/list"
const apiBody = JSON.stringify({ data: { list: [{ h: "J1", l: "https://api.example/1" }] } })
const pages = { [FEED]: RSS(FEED_ITEMS, "Feed 标题"), [API]: apiBody, [PAGE]: "<ul><li><a href='/x'>R1</a></li></ul>" }
const jsonSpec = { kind: "json", url: API, itemsPath: "data.list", fields: { title: "h", url: "l" } }
const ruleSpec = { kind: "rule", url: PAGE, item: "li", fields: { title: "a", url: "a@href" } }

describe("用户源服务：添加流程", () => {
  it("给地址 → 预览 → 保存：预览不落库，保存后出现在列表", async () => {
    const w = await setupWorld(pages)
    const preview = await w.service.preview({ url: FEED })
    expect(preview.name).toBe("Feed 标题")
    expect(preview.items).toHaveLength(5)
    expect(await w.service.list()).toEqual([])

    const saved = await w.service.create({ name: preview.name, category: "科技", spec: preview.spec })
    expect(saved).toMatchObject({ id: "user:feed", slug: "feed", name: "Feed 标题", category: "科技", enabled: true, interval: 600_000, health: null })
    expect((await w.service.list()).map(s => s.id)).toEqual(["user:feed"])
  })

  it("四种 kind 都能预览手写的 spec；json 与 rule 给映射", async () => {
    const w = await setupWorld(pages)
    expect((await w.service.preview({ spec: jsonSpec })).items[0]).toMatchObject({ title: "J1", url: "https://api.example/1" })
    expect((await w.service.preview({ spec: ruleSpec })).items[0]).toMatchObject({ title: "R1", url: "https://page.example/x" })
    expect((await w.service.preview({ spec: { kind: "rss", url: FEED } })).total).toBe(8)
  })

  it("slug 重名自动加序号；手动指定的 slug 重名返回 409", async () => {
    const w = await setupWorld(pages)
    const mk = (extra = {}) => w.service.create({ name: "同名", spec: { kind: "rss", url: FEED }, ...extra })
    expect((await mk()).slug).toBe("feed-example")
    expect((await mk()).slug).toBe("feed-example-2")
    await mk({ slug: "mine" })
    await expect(mk({ slug: "mine" })).rejects.toMatchObject({ status: 409 })
  })

  it("校验：名称、间隔、地址、保留 slug、内网地址", async () => {
    const w = await setupWorld(pages)
    const bad = (body: Record<string, unknown>) => expect(w.service.create({ name: "n", spec: { kind: "rss", url: FEED }, ...body })).rejects.toBeInstanceOf(InputError)
    await bad({ name: "" })
    await bad({ interval: 1000 })
    await bad({ slug: "opml" })
    await bad({ spec: { kind: "rss", url: "file:///etc/passwd" } })
    await bad({ spec: { kind: "rss", url: "http://169.254.169.254/latest" } })
    await bad({ spec: { kind: "rss", url: "http://localhost:3000/feed" } })
    expect(await w.service.list()).toEqual([])
  })

  it("预览内网地址被拒绝，且没有出网", async () => {
    const w = await setupWorld(pages)
    await expect(w.service.preview({ url: "http://10.0.0.8/feed" })).rejects.toMatchObject({ status: 403 })
    expect(w.calls).toEqual([])
  })
})

describe("用户源服务：改、停用、删除", () => {
  it("部分更新只改给的项；改 spec 清掉健康记录", async () => {
    const w = await setupWorld(pages)
    await w.service.create({ name: "A", interval: 120_000, category: "x", spec: { kind: "rss", url: FEED }, slug: "a" })
    await w.observations.recordFailure("user:a", 1, new Error("boom"))
    const renamed = await w.service.update("a", { name: "B" })
    expect(renamed).toMatchObject({ name: "B", category: "x", interval: 120_000, enabled: true })
    expect(renamed.health?.consecutiveFailures).toBe(1)
    const moved = await w.service.update("a", { spec: jsonSpec })
    expect(moved.spec.kind).toBe("json")
    expect(moved.health).toBeNull()
    await expect(w.service.update("nope", { name: "x" })).rejects.toMatchObject({ status: 404 })
    await expect(w.service.update("a", { interval: 5 })).rejects.toBeInstanceOf(InputError)
  })

  it("删除不存在的返回 404", async () => {
    const w = await setupWorld(pages)
    await expect(w.service.remove("nope")).rejects.toMatchObject({ status: 404 })
  })
})

describe("opml 导入导出", () => {
  async function seed(w: Awaited<ReturnType<typeof setupWorld>>) {
    await w.service.create({ slug: "feed", name: "Feed & <标题>", category: "科技", interval: 120_000, spec: { kind: "rss", url: `${FEED}?a=1&b="2"` } })
    await w.service.create({ slug: "hub", name: "RSSHub 源", category: "科技", interval: 3_600_000, enabled: false, spec: { kind: "rsshub", route: "/github/trending/daily?language=ts", limit: 10 } })
    await w.service.create({ slug: "api", name: "JSON 源", category: "财经", spec: jsonSpec })
    await w.service.create({ slug: "page", name: "规则源", spec: ruleSpec })
  }

  it("导出 → 导入到空库：名称、分类、间隔、启停、spec 原样恢复", async () => {
    const a = await setupWorld(pages)
    await seed(a)
    const xml = await a.service.exportOpml()
    expect(xml).toContain("<opml version=\"2.0\"")
    expect(xml).toContain("type=\"rss\"")
    const b = await setupWorld(pages)
    const result = await b.service.importOpml(xml)
    expect(result).toMatchObject({ imported: expect.arrayContaining(["user:feed", "user:hub", "user:api", "user:page"]), replaced: [], skipped: [], failed: [] })
    const pick = async (w: typeof a) => (await w.service.list()).map(({ createdAt, updatedAt, health, ...rest }) => rest).sort((x, y) => x.slug.localeCompare(y.slug))
    expect(await pick(b)).toEqual(await pick(a))
    // 再导出一遍字节一致（日期头除外）
    const body = (s: string) => s.replace(/<dateCreated>.*<\/dateCreated>/, "")
    expect(body(await b.service.exportOpml())).toBe(body(xml))
  })

  it("标准部分能被通行的阅读器读：分类是文件夹，RSS 类有 xmlUrl", async () => {
    const a = await setupWorld(pages)
    await seed(a)
    const entries = parseOpml(await a.service.exportOpml())
    expect(entries.find(e => e.slug === "feed")).toMatchObject({ category: "科技", name: "Feed & <标题>", spec: { kind: "rss", url: `${FEED}?a=1&b=%222%22` } })
    expect(entries.find(e => e.slug === "page")?.category).toBe("")
  })

  it("导入别的阅读器导出的 OPML：嵌套文件夹当分类，按地址去重，生成 slug", async () => {
    const w = await setupWorld(pages)
    const foreign = `<?xml version="1.0"?><opml version="1.0"><head><title>x</title></head><body>
      <outline text="新闻"><outline text="子夹"><outline type="rss" text="A 站" xmlUrl="https://a.example/feed"/></outline></outline>
      <outline type="rss" title="B 站" xmlUrl="https://b.example/feed.xml"/>
      <outline type="rss" text="A 站重复" xmlUrl="https://a.example/feed"/>
      <outline type="rss" text="坏的" xmlUrl="ftp://x/y"/>
    </body></opml>`
    const r = await w.service.importOpml(foreign)
    expect(r.imported).toEqual(["user:a", "user:b"])
    expect(r.skipped).toEqual([{ name: "A 站重复", reason: "已有相同地址的源" }])
    expect(r.failed).toHaveLength(1)
    expect((await w.service.get("a")).category).toBe("子夹")
    // 再导一次：全部跳过，不重复
    const again = await w.service.importOpml(foreign)
    expect(again.imported).toEqual([])
  })

  it("slug 冲突：默认跳过保留现有，replace 用文件里的覆盖", async () => {
    const a = await setupWorld(pages)
    await seed(a)
    const xml = await a.service.exportOpml()
    await a.service.update("feed", { name: "本地改过" })
    const skipped = await a.service.importOpml(xml)
    expect(skipped.imported).toEqual([])
    expect(skipped.skipped).toHaveLength(4)
    expect((await a.service.get("feed")).name).toBe("本地改过")
    const replaced = await a.service.importOpml(xml, "replace")
    expect(replaced.replaced).toHaveLength(4)
    expect((await a.service.get("feed")).name).toBe("Feed & <标题>")
  })

  it("拒绝：不是 OPML、内网地址、坏的 katana:spec、超大文件", async () => {
    const w = await setupWorld(pages)
    await expect(w.service.importOpml("<html/>")).rejects.toBeInstanceOf(InputError)
    await expect(w.service.importOpml("not xml at all <<<")).rejects.toBeInstanceOf(InputError)
    const xml = `<opml version="2.0" xmlns:katana="x"><body>
      <outline type="rss" text="内网" xmlUrl="http://127.0.0.1:9/feed"/>
      <outline type="link" text="坏 spec" url="https://a.example/" katana:kind="json" katana:spec="{oops"/>
    </body></opml>`
    const r = await w.service.importOpml(xml)
    expect(r.imported).toEqual([])
    expect(r.failed.map(f => f.name)).toEqual(["内网", "坏 spec"])
    await expect(w.service.importOpml(`<opml><body>${" ".repeat(1024 * 1024)}</body></opml>`)).rejects.toMatchObject({ status: 413 })
  })

  it("导出 XML 转义：名称里的 & < > \" 不会破坏文件", () => {
    const xml = exportOpml([{ slug: "x", name: "a&b<c>\"d\" e", category: "k&l", interval: 120_000, enabled: true, spec: { kind: "rss", url: "https://a.example/?x=1&y=2" }, createdAt: 1, updatedAt: 1 }], "https://hub.example", new Date(0))
    const [e] = parseOpml(xml)
    expect(e).toMatchObject({ name: "a&b<c>\"d\" e", category: "k&l", spec: { url: "https://a.example/?x=1&y=2" } })
  })
})
