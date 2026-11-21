import { describe, expect, it } from "vitest"
import { FEED, OTHER, actionsWorld, http, mcp, rssBody } from "./helpers"
import { InputError } from "#/registry/spec"
import { cleanActor, diffSources } from "#/actions/actions"

describe("动作层：每个改动写审计（谁、何时、改了什么、前后值）", () => {
  it("新增：入口与调用方名、时间、前后值都记下；响应带 auditId", async () => {
    const w = await actionsWorld()
    const { value, auditId } = await w.actions.addSource(mcp("claude-agent"), rssBody({ category: "科技" }))
    expect(value.id).toBe("user:example")
    expect(auditId).toBe(1)
    const [rec] = await w.actions.listAudit()
    expect(rec).toMatchObject({ id: 1, entry: "mcp", actor: "claude-agent", action: "source.add", undoOf: null, undoneBy: null })
    expect(rec.at).toBeGreaterThan(0)
    expect(rec.summary).toBe("新增 user:example「示例」")
    expect(rec.changes).toEqual([{
      slug: "example",
      before: null,
      after: { name: "示例", category: "科技", interval: 120_000, enabled: true, spec: { kind: "rss", url: FEED } },
    }])
  })

  it("改分类、改间隔、启停、改配置：各自记前后值，动作名区分", async () => {
    const w = await actionsWorld()
    await w.actions.addSource(http, rssBody())
    await w.actions.setCategory(http, "example", "财经")
    await w.actions.setInterval(mcp("a"), "example", 600_000)
    await w.actions.setEnabled(mcp("a"), "example", false)
    await w.actions.setEnabled(mcp("a"), "example", true)
    await w.actions.updateSource(http, "example", { name: "新名字", spec: { kind: "rss", url: OTHER } })
    const recs = (await w.actions.listAudit()).reverse()
    expect(recs.map(r => r.action)).toEqual(["source.add", "source.set-category", "source.set-interval", "source.disable", "source.enable", "source.update"])
    expect(recs[1].changes[0]).toMatchObject({ before: { category: "" }, after: { category: "财经" } })
    expect(recs[2].changes[0]).toMatchObject({ before: { interval: 120_000 }, after: { interval: 600_000 } })
    expect(recs[3].changes[0]).toMatchObject({ before: { enabled: true }, after: { enabled: false } })
    expect(recs[5].summary).toBe("修改 user:example「新名字」：名称、配置")
    expect(recs[5].changes[0].before!.spec).toEqual({ kind: "rss", url: FEED })
    expect(recs[5].changes[0].after!.spec).toEqual({ kind: "rss", url: OTHER })
  })

  it("什么都没改变的动作不写审计；校验不通过的请求不写审计也不改库", async () => {
    const w = await actionsWorld()
    await w.actions.addSource(http, rssBody())
    const same = await w.actions.setEnabled(http, "example", true)
    expect(same.auditId).toBeNull()
    await expect(w.actions.setInterval(http, "example", 5)).rejects.toBeInstanceOf(InputError)
    await expect(w.actions.addSource(http, rssBody({ spec: { kind: "rss", url: "ftp://x" } }))).rejects.toBeInstanceOf(InputError)
    await expect(w.actions.removeSource(http, "不存在")).rejects.toBeInstanceOf(InputError)
    expect(await w.actions.listAudit()).toHaveLength(1)
  })

  it("调用方名只留可见字符并限长；审计分页", async () => {
    expect(cleanActor("  a\nb\u0000c  ")).toBe("a b c")
    expect(cleanActor("x".repeat(100))).toHaveLength(64)
    expect(cleanActor("   ")).toBeNull()
    expect(cleanActor(123)).toBeNull()
    const w = await actionsWorld()
    await w.actions.addSource(http, rssBody())
    for (let i = 0; i < 5; i++) await w.actions.setCategory(http, "example", `c${i}`)
    const page1 = await w.actions.listAudit(4)
    expect(page1.map(r => r.id)).toEqual([6, 5, 4, 3])
    expect((await w.actions.listAudit(4, 3)).map(r => r.id)).toEqual([2, 1])
    await expect(w.actions.listAudit(0)).rejects.toBeInstanceOf(InputError)
  })

  it("并发的两个动作互不夹带：各自的审计只含自己改的那一个源", async () => {
    const w = await actionsWorld()
    await Promise.all([
      w.actions.addSource(http, rssBody({ slug: "a", name: "A" })),
      w.actions.addSource(mcp("x"), rssBody({ slug: "b", name: "B", spec: { kind: "rss", url: OTHER } })),
    ])
    const recs = await w.actions.listAudit()
    expect(recs.map(r => r.changes.map(c => c.slug))).toEqual([["b"], ["a"]])
  })

  it("diffSources：忽略时间戳，只比配置", () => {
    const base = { slug: "s", name: "n", category: "", interval: 1, enabled: true, spec: { kind: "rss", url: "u" } as const }
    expect(diffSources([{ ...base, createdAt: 1, updatedAt: 1 }], [{ ...base, createdAt: 1, updatedAt: 99 }])).toEqual([])
  })
})

describe("撤销", () => {
  it("撤销新增：源消失；撤销本身写审计，原记录标为已撤销", async () => {
    const w = await actionsWorld()
    const { auditId } = await w.actions.addSource(mcp("agent"), rssBody())
    expect((await w.actions.list()).map(s => s.id)).toEqual(["user:example"])
    const undone = await w.actions.undo(mcp("agent"), auditId!)
    expect(await w.actions.list()).toEqual([])
    expect(undone.value).toMatchObject({ id: 2, action: "audit.undo", undoOf: 1, entry: "mcp", actor: "agent" })
    expect(undone.value.summary).toContain("撤销 #1")
    expect((await w.audit.get(1))!.undoneBy).toBe(2)
  })

  it("撤销删除：配置原样回来（名称、分类、间隔、启停、配置）", async () => {
    const w = await actionsWorld()
    await w.actions.addSource(http, rssBody({ category: "科技", interval: 300_000, enabled: false }))
    const before = (await w.actions.get("example"))
    const { auditId } = await w.actions.removeSource(mcp(), "example")
    expect(await w.actions.list()).toEqual([])
    await w.actions.undo(mcp(), auditId!)
    const after = await w.actions.get("example")
    expect({ ...after, createdAt: 0, updatedAt: 0 }).toEqual({ ...before, createdAt: 0, updatedAt: 0 })
  })

  it("撤销修改：回到改之前", async () => {
    const w = await actionsWorld()
    await w.actions.addSource(http, rssBody({ category: "旧" }))
    const { auditId } = await w.actions.updateSource(mcp(), "example", { category: "新", interval: 900_000, spec: { kind: "rss", url: OTHER } })
    await w.actions.undo(http, auditId!)
    expect(await w.actions.get("example")).toMatchObject({ category: "旧", interval: 120_000, spec: { kind: "rss", url: FEED } })
  })

  it("撤销一条撤销记录就是重做；已撤销的不能再撤销", async () => {
    const w = await actionsWorld()
    const { auditId } = await w.actions.addSource(http, rssBody())
    const u1 = await w.actions.undo(http, auditId!)
    await expect(w.actions.undo(http, auditId!)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已被撤销") })
    expect(await w.actions.list()).toEqual([])
    // 重做
    const redo = await w.actions.undo(http, u1.auditId!)
    expect((await w.actions.list()).map(s => s.id)).toEqual(["user:example"])
    expect((await w.audit.get(u1.auditId!))!.undoneBy).toBe(redo.auditId)
    expect((await w.audit.get(auditId!))!.undoneBy).toBeNull() // 原记录重新生效
    // 原记录又可以撤销了
    await w.actions.undo(http, auditId!)
    expect(await w.actions.list()).toEqual([])
  })

  it("之后又被改过的不能直接撤销（409，不覆盖后来的改动），先撤销后面的就行", async () => {
    const w = await actionsWorld()
    const add = await w.actions.addSource(http, rssBody())
    const edit = await w.actions.setCategory(http, "example", "改过")
    await expect(w.actions.undo(http, add.auditId!)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("之后又被改过") })
    expect(await w.actions.get("example")).toMatchObject({ category: "改过" })
    await w.actions.undo(http, edit.auditId!)
    await w.actions.undo(http, add.auditId!)
    expect(await w.actions.list()).toEqual([])
  })

  it("导入一批：一条审计，撤销整批；replace 的撤销回到被覆盖前的配置", async () => {
    const w = await actionsWorld()
    await w.actions.addSource(http, rssBody({ slug: "keep", name: "原来的", category: "旧", spec: { kind: "rss", url: OTHER } }))
    const xml = await (async () => {
      const src = await actionsWorld()
      await src.actions.addSource(http, rssBody({ slug: "keep", name: "文件里的", category: "新" }))
      await src.actions.addSource(http, rssBody({ slug: "fresh-a", name: "新 A", spec: { kind: "rss", url: "https://a.example/rss" } }))
      await src.actions.addSource(http, rssBody({ slug: "fresh-b", name: "新 B", spec: { kind: "rss", url: "https://b.example/rss" } }))
      return await src.actions.exportOpml()
    })()
    const imported = await w.actions.importOpml(mcp("agent"), xml, "replace")
    expect(imported.value.imported.sort()).toEqual(["user:fresh-a", "user:fresh-b"])
    expect(imported.value.replaced).toEqual(["user:keep"])
    const rec = (await w.audit.get(imported.auditId!))!
    expect(rec.changes.map(c => [c.slug, c.before?.name ?? null, c.after?.name ?? null])).toEqual([
      ["fresh-a", null, "新 A"],
      ["fresh-b", null, "新 B"],
      ["keep", "原来的", "文件里的"],
    ])
    expect(await w.actions.list()).toHaveLength(3)
    await w.actions.undo(http, imported.auditId!)
    expect((await w.actions.list()).map(s => [s.id, s.name, s.category])).toEqual([["user:keep", "原来的", "旧"]])
  })

  it("撤销一组改动时中途有一项做不下去：已经做了的照样记审计，报错，原记录不标为已撤销", async () => {
    const w = await actionsWorld()
    // 绕过服务层直接写一个指向内网的老配置（如今的出网策略不许新建）
    await w.store.insert({ slug: "a-keep", name: "旧", category: "", interval: 120_000, enabled: true, spec: { kind: "rss", url: "http://127.0.0.1/feed" } }, 1)
    const src = await actionsWorld()
    await src.actions.addSource(http, rssBody({ slug: "a-keep", name: "新" }))
    await src.actions.addSource(http, rssBody({ slug: "z-fresh", name: "新增", spec: { kind: "rss", url: OTHER } }))
    const imported = await w.actions.importOpml(http, await src.actions.exportOpml(), "replace")
    expect(imported.auditId).not.toBeNull()
    await expect(w.actions.undo(mcp("agent"), imported.auditId!)).rejects.toBeInstanceOf(InputError)
    // z-fresh 已经被撤销掉了，a-keep 没能还原
    expect((await w.actions.list()).map(s => [s.id, s.name])).toEqual([["user:a-keep", "新"]])
    const [undoRec] = await w.actions.listAudit(1)
    expect(undoRec).toMatchObject({ action: "audit.undo", undoOf: imported.auditId, actor: "agent" })
    expect(undoRec.changes.map(c => c.slug)).toEqual(["z-fresh"])
    expect((await w.audit.get(imported.auditId!))!.undoneBy).toBeNull()
  })

  it("撤销前先查现状：占了同名 slug 的新配置不被覆盖（409）", async () => {
    const w = await actionsWorld()
    await w.actions.addSource(http, rssBody({ slug: "a" }))
    const del = await w.actions.removeSource(http, "a")
    await w.actions.addSource(http, rssBody({ slug: "a", name: "占位", spec: { kind: "rss", url: OTHER } }))
    await expect(w.actions.undo(http, del.auditId!)).rejects.toMatchObject({ status: 409 })
    expect(await w.actions.get("a")).toMatchObject({ name: "占位" })
    expect((await w.audit.get(del.auditId!))!.undoneBy).toBeNull()
  })

  it("没有这条记录 → 404", async () => {
    const w = await actionsWorld()
    await expect(w.actions.undo(http, 99)).rejects.toMatchObject({ status: 404 })
    await expect(w.actions.undo(http, 0)).rejects.toBeInstanceOf(InputError)
  })
})
