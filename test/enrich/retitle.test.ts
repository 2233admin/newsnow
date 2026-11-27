import { describe, expect, it } from "vitest"
import { T0, descriptors, feedWorld, ingest, row } from "../feed/helpers"
import { titleKey } from "#/enrich/dedup"
import { createTagger } from "#/enrich/tagger"

// 审阅 #8 第 4 项：同一条目再采到、标题变了，清洗标题、标的、去重键跟着变，主条目身份（seq、组）不变。
function DESCS() {
  return descriptors([
    { id: "cls-telegraph", name: "财联社电报", category: "finance", builtin: true, enabled: true },
    { id: "ths", name: "同花顺快讯", category: "finance", builtin: true, enabled: true },
  ])
}

describe("标题变了再采到：富化跟着更新", () => {
  it("清洗标题、标的、title_key 更新，seq 与分组不变", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    await ingest(w, "ths", [row("a", { title: "快讯：芯片板块早盘走强，市场情绪回暖，成交放大", url: "https://t.example/a" })], T0)
    expect((await w.service.query({ symbol: "NVDA.XNAS" })).items).toEqual([])
    const before = (await w.service.query({})).items[0]
    const edited = "快讯：英伟达财报超预期 &amp; 盘后大涨，市场情绪回暖"
    const fresh = await ingest(w, "ths", [row("a", { title: edited, url: "https://t.example/a" })], T0 + 60_000)
    expect(fresh).toEqual([]) // 不是新条目
    const after = (await w.service.query({})).items[0]
    expect(after.seq).toBe(before.seq)
    expect(after.cleanTitle).toBe("快讯：英伟达财报超预期 & 盘后大涨，市场情绪回暖")
    expect(after.symbols).toEqual(["NVDA.XNAS"])
    expect((await w.service.query({ symbol: "NVDA.XNAS" })).items.map(i => i.itemId)).toEqual(["a"])
    const key = await w.db.prepare("SELECT title_key AS k FROM items WHERE seq = ?").get(before.seq) as { k: string }
    expect(key.k).toBe(titleKey(after.cleanTitle))
  })

  it("标题没变、标题变成没有标的：旧标的被清掉", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    await ingest(w, "ths", [row("a", { title: "英伟达发布新一代芯片，股价盘中上涨", url: "https://t.example/a" })], T0)
    expect((await w.service.query({ symbol: "NVDA.XNAS" })).items).toHaveLength(1)
    await ingest(w, "ths", [row("a", { title: "英伟达发布新一代芯片，股价盘中上涨", url: "https://t.example/a" })], T0 + 60_000)
    expect((await w.service.query({ symbol: "NVDA.XNAS" })).items).toHaveLength(1)
    await ingest(w, "ths", [row("a", { title: "某公司发布新一代芯片，市场反应平淡无奇", url: "https://t.example/a" })], T0 + 120_000)
    expect((await w.service.query({ symbol: "NVDA.XNAS" })).items).toEqual([])
  })

  it("成员改了标题：仍是同一组的成员，标的随之更新", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    const T = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
    await ingest(w, "cls-telegraph", [row("c", { title: T, url: "https://c.example/1" })], T0)
    await ingest(w, "ths", [row("t", { title: T, url: "https://t.example/1" })], T0 + 1000)
    await ingest(w, "ths", [row("t", { title: `${T}（英伟达参与）`, url: "https://t.example/1" })], T0 + 2000)
    const all = (await w.service.query({ expand: "1" })).items
    const member = all.find(i => i.itemId === "t")!
    expect(member.dupOf).toBe(1)
    expect(member.symbols).toEqual(["NVDA.XNAS"])
    expect((await w.service.query({ symbol: "NVDA.XNAS" })).items.map(i => i.itemId)).toEqual(["c"]) // 按组命中，默认出主条目
  })
})

// 独立审 M4：标题变了，原来按旧标题打的标注要作废、按新标题重标。
describe("标题变了再采到：批量标注跟着重标", () => {
  const tagAll = (w: Awaited<ReturnType<typeof feedWorld>>, prompts: string[]) => createTagger({
    store: w.enricher.store,
    llm: async (req) => {
      prompts.push(req.user)
      const n = (req.user.match(/^\[\d+\]/gm) ?? []).length
      return JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, t: "公告", d: "0", g: `第 ${prompts.length} 次`, k: [] })))
    },
    sourceIds: async () => null,
  })

  it("主条目标题变了：tags 回到 null、tag_attempts 清零，下一轮按新标题重标；标题没变不动", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    const prompts: string[] = []
    const tagger = tagAll(w, prompts)
    await ingest(w, "ths", [row("a", { title: "某公司发布三季度业绩预告，净利润同比增长超过五成", url: "https://t.example/a" })], T0)
    await tagger.run()
    expect((await w.service.query({})).items[0].tags).toMatchObject({ gist: "第 1 次" })
    // 同样的标题再采到：不动
    await ingest(w, "ths", [row("a", { title: "某公司发布三季度业绩预告，净利润同比增长超过五成", url: "https://t.example/a" })], T0 + 60_000)
    expect((await w.service.query({})).items[0].tags).toMatchObject({ gist: "第 1 次" })
    // 标题改了（更正）：旧标注作废
    await ingest(w, "ths", [row("a", { title: "更正：某公司三季度业绩预告净利润同比增长约两成，此前数字有误", url: "https://t.example/a" })], T0 + 120_000)
    expect((await w.service.query({})).items[0].tags).toBeNull()
    await tagger.run()
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("更正：某公司三季度业绩预告")
    expect((await w.service.query({})).items[0].tags).toMatchObject({ gist: "第 2 次" })
  })

  it("成员改标题不动组的标注（标注是按主条目的标题打的）", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    const prompts: string[] = []
    const T = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
    await ingest(w, "cls-telegraph", [row("c", { title: T, url: "https://c.example/1" })], T0)
    await ingest(w, "ths", [row("t", { title: T, url: "https://t.example/1" })], T0 + 1000)
    await tagAll(w, prompts).run()
    await ingest(w, "ths", [row("t", { title: `${T}（编辑稿）`, url: "https://t.example/1" })], T0 + 2000)
    expect((await w.service.query({})).items[0].tags).toMatchObject({ impact: "公告" })
  })

  it("主条目被过滤、标注来源是成员：成员改标题要重标这一组；主条目没被过滤时成员改标题不动（上一条）", async () => {
    const w = await feedWorld(DESCS(), { enrich: true })
    const prompts: string[] = []
    const tagger = tagAll(w, prompts)
    await ingest(w, "cls-telegraph", [row("spam", { title: "加微信领取今日牛股名单，限时免费，明日必涨停，机会难得", url: "https://s.example/same?utm_source=x" })], T0)
    await ingest(w, "ths", [row("real", { title: "某公司发布重大合同公告，金额超过去年营收的一半，股价异动明显", url: "https://s.example/same" })], T0 + 1000)
    await tagger.run()
    expect(prompts[0]).toContain("重大合同公告")
    expect((await w.service.query({})).items[0].tags).toMatchObject({ gist: "第 1 次" })
    await ingest(w, "ths", [row("real", { title: "更正：某公司重大合同公告金额为去年营收的三成，此前数字有误，股价异动明显", url: "https://s.example/same" })], T0 + 60_000)
    expect((await w.service.query({})).items[0].tags).toBeNull()
    await tagger.run()
    expect(prompts[1]).toContain("更正：某公司重大合同公告")
    expect((await w.service.query({})).items[0].tags).toMatchObject({ gist: "第 2 次" })
  })
})
