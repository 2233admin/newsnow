import { describe, expect, it, vi } from "vitest"
import { FEED_ITEMS, RSS, setupWorld } from "./helpers"
import { COLLECTOR_DEFAULTS } from "#/collector/config"
import { createCollector } from "#/collector/collect"
import { createRegistry } from "#/registry/registry"
import { loadPack, parsePack, presetsToOpml } from "#/registry/presets"
import { createPresetService } from "#/registry/preset-service"
import { parseOpml } from "#/registry/opml"
import { InputError } from "#/registry/spec"
import { RSSHUB_BASE } from "#/utils/source"

const MIN = 60_000
const quiet = { info: () => {}, warn: () => {} }
const pack = loadPack(RSSHUB_BASE)
const BLOOMBERG = pack.sources.find(s => s.slug === "preset-bloomberg-markets")!
const ARXIV = pack.sources.find(s => s.slug === "preset-arxiv-q-fin")!
const bloombergUrl = (BLOOMBERG.spec as { url: string }).url
const arxivUrl = (ARXIV.spec as { url: string }).url
const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>arXiv Query</title>
<entry><id>http://arxiv.org/abs/2611.0001v1</id><title>Paper One</title><updated>2026-11-19T09:00:00Z</updated>
<link href="https://arxiv.org/abs/2611.0001v1" rel="alternate" type="text/html"/><link href="https://arxiv.org/pdf/2611.0001v1" rel="related" type="application/pdf" title="pdf"/>
<published>2026-11-19T09:00:00Z</published></entry></feed>`

async function setup() {
  const w = await setupWorld({ [bloombergUrl]: RSS(FEED_ITEMS, "Bloomberg Markets"), [arxivUrl]: ARXIV_ATOM })
  const registry = createRegistry({ builtinSources: { hn: { interval: 10 * MIN } }, builtinGetters: { hn: async () => [{ id: "b1", title: "内置", url: "https://b/1" }] }, store: w.store, fetchText: w.fetchText, log: quiet })
  let now = 1_000_000
  const collector = createCollector({ store: w.observations, resolve: () => registry.snapshot(), config: { enabled: true, ...COLLECTOR_DEFAULTS }, clock: () => now, log: quiet })
  const presets = createPresetService({ service: w.service, pack })
  return { ...w, registry, collector, presets, advance: (ms: number) => {
    now += ms
  } }
}

describe("预置订阅包（数据文件）", () => {
  it("随仓库的 feeds.json 通过模块 2 的全部校验，且覆盖要求的几家", () => {
    expect(pack.sources.length).toBeGreaterThanOrEqual(17)
    const names = pack.sources.map(s => s.name).join("|")
    for (const must of ["Bloomberg", "Reuters", "AP ", "TechCrunch", "arXiv", "r/wallstreetbets", "YouTube"]) expect(names).toContain(must)
    for (const s of pack.sources) {
      expect(s.slug).toMatch(/^preset-/)
      expect(s.enabled).toBe(false)
      expect(s.origin.readAt).toMatch(/^2026-/)
    }
    expect(new Set(pack.sources.map(s => s.slug)).size).toBe(pack.sources.length)
  })

  it("坏的预置包被拒绝：slug 不以 preset- 开头、重名、没写间隔、地址不是 http", () => {
    const good = JSON.parse(JSON.stringify(pack.sources[0]))
    const wrap = (...sources: any[]) => ({ version: 1, description: "x", sources })
    expect(() => parsePack(wrap(good), RSSHUB_BASE)).not.toThrow()
    expect(() => parsePack(wrap({ ...good, slug: "bloomberg" }), RSSHUB_BASE)).toThrow(InputError)
    expect(() => parsePack(wrap(good, good), RSSHUB_BASE)).toThrow(/重复/)
    expect(() => parsePack(wrap({ ...good, interval: undefined }), RSSHUB_BASE)).toThrow(/interval/)
    expect(() => parsePack(wrap({ ...good, spec: { kind: "rss", url: "file:///etc/passwd" } }), RSSHUB_BASE)).toThrow(InputError)
    expect(() => parsePack({ version: 2, description: "x", sources: [] }, RSSHUB_BASE)).toThrow(InputError)
  })
})

describe("默认不启用", () => {
  it("没人启用时：库里没有任何用户源，列表全是 available，注册表与采集都不碰预置源", async () => {
    const w = await setup()
    expect(await w.service.list()).toEqual([])
    const list = await w.presets.list()
    expect(list).toHaveLength(pack.sources.length)
    expect(list.every(p => p.state === "available" && p.health === null && !p.modified)).toBe(true)
    expect(Object.keys((await w.registry.snapshot()).sources)).toEqual(["hn"])
    const tick = await w.collector.tick()
    expect(tick.due).toEqual(["hn"])
    expect(w.calls).toEqual([])
  })

  it("预置包的 OPML 经现有导入接口导入后全部是停用状态，预置列表显示 disabled，采集不碰它们", async () => {
    const w = await setup()
    const xml = presetsToOpml(pack.sources, RSSHUB_BASE, new Date(0))
    expect(parseOpml(xml).every(e => e.enabled === false)).toBe(true)
    const result = await w.service.importOpml(xml)
    expect(result.failed).toEqual([])
    expect(result.imported).toHaveLength(pack.sources.length)
    expect((await w.service.list()).every(s => !s.enabled)).toBe(true)
    expect((await w.presets.list()).every(p => p.state === "disabled" && !p.modified)).toBe(true)
    expect(Object.keys((await w.registry.snapshot()).sources)).toEqual(["hn"])
    expect((await w.collector.tick()).due).toEqual(["hn"])
    expect(w.calls).toEqual([])
  })

  it("opml 里是分类文件夹 + 标准 xmlUrl，别的阅读器能直接读", () => {
    const xml = presetsToOpml(pack.sources, RSSHUB_BASE, new Date(0))
    expect(xml).toContain(`<outline text="财经" title="财经">`)
    expect(xml).toContain(`type="rss" xmlUrl="${bloombergUrl}"`)
    expect(xml).toMatch(/katana:slug="preset-bloomberg-markets"[^>]*katana:enabled="false"/)
  })
})

describe("启用 / 停用", () => {
  it("启用后就是普通用户源：进注册表、下一轮被采集、有观测与健康；停用后不再采集、历史保留", async () => {
    const w = await setup()
    const view = await w.presets.enable("preset-bloomberg-markets")
    expect(view).toMatchObject({ id: "user:preset-bloomberg-markets", state: "enabled", modified: false, interval: BLOOMBERG.interval })
    expect((await w.service.get("preset-bloomberg-markets")).enabled).toBe(true)

    const tick = await w.collector.tick()
    expect(tick.succeeded).toContain("user:preset-bloomberg-markets")
    const obs = async () => ((await w.db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE source_id = 'user:preset-bloomberg-markets'`).all()) as any[])[0].n
    expect(await obs()).toBe(8)
    expect((await w.presets.get("preset-bloomberg-markets")).health).toMatchObject({ consecutiveFailures: 0, lastItemCount: 8 })

    const off = await w.presets.disable("preset-bloomberg-markets")
    expect(off.state).toBe("disabled")
    w.advance(BLOOMBERG.interval + MIN)
    expect((await w.collector.tick()).due).not.toContain("user:preset-bloomberg-markets")
    expect(await obs()).toBe(8)

    expect((await w.presets.enable("preset-bloomberg-markets")).state).toBe("enabled")
    w.advance(MIN)
    expect((await w.collector.tick()).succeeded).toContain("user:preset-bloomberg-markets")
    expect(await obs()).toBe(16)
  })

  it("启用与停用是幂等的；没启用过的源停用不会凭空建行", async () => {
    const w = await setup()
    await w.presets.disable("preset-techcrunch")
    expect(await w.service.list()).toEqual([])
    await w.presets.enable("preset-techcrunch")
    await w.presets.enable("preset-techcrunch")
    expect((await w.service.list()).map(s => s.slug)).toEqual(["preset-techcrunch"])
    await w.presets.disable("preset-techcrunch")
    await w.presets.disable("preset-techcrunch")
    expect((await w.presets.get("preset-techcrunch")).state).toBe("disabled")
  })

  it("用户改过的设置不被预置值覆盖；删掉那一行后预置回到 available", async () => {
    const w = await setup()
    await w.presets.enable("preset-bloomberg-markets")
    await w.service.update("preset-bloomberg-markets", { interval: 5 * MIN, name: "我的彭博" })
    await w.presets.disable("preset-bloomberg-markets")
    const again = await w.presets.enable("preset-bloomberg-markets")
    expect(again).toMatchObject({ state: "enabled", modified: true, interval: 5 * MIN, name: "我的彭博" })
    await w.service.remove("preset-bloomberg-markets")
    expect((await w.presets.get("preset-bloomberg-markets")).state).toBe("available")
  })

  it("rule 类的预置源（arXiv API）能被采集出条目，链接取 rel=alternate", async () => {
    const w = await setup()
    await w.presets.enable("preset-arxiv-q-fin")
    expect((await w.collector.tick()).succeeded).toContain("user:preset-arxiv-q-fin")
    const items = await w.db.prepare(`SELECT title, url FROM items WHERE source_id = 'user:preset-arxiv-q-fin'`).all() as any[]
    expect(items).toEqual([{ title: "Paper One", url: "https://arxiv.org/abs/2611.0001v1" }])
  })

  it("未知的预置 slug 返回 404；名额满时启用报 409 而不是静默吞掉", async () => {
    const w = await setup()
    await expect(w.presets.enable("preset-nope")).rejects.toMatchObject({ status: 404 })
    await expect(w.presets.disable("bloomberg")).rejects.toMatchObject({ status: 404 })
    const full = createPresetService({ service: { ...w.service, list: async () => [], create: async () => {
      throw new InputError("用户源已达上限 200", 409)
    } } as any, pack })
    await expect(full.enable("preset-techcrunch")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("上限") })
  })

  it("并发：另一个请求刚创建了同一行时，启用落到更新而不是报错", async () => {
    const w = await setup()
    const racing = vi.fn(async () => {
      await w.service.create({ slug: "preset-techcrunch", name: "x", spec: BLOOMBERG.spec, enabled: false })
      throw new InputError("user:preset-techcrunch 已存在", 409)
    })
    const presets = createPresetService({ service: { ...w.service, create: racing } as any, pack })
    expect((await presets.enable("preset-techcrunch")).state).toBe("enabled")
  })
})
