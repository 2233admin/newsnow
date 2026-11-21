import { describe, expect, it } from "vitest"
import { FEED_ITEMS, RSS, setupWorld } from "./helpers"
import { InputError } from "#/registry/spec"

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
