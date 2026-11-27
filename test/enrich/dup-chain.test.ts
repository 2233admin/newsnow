import { describe, expect, it } from "vitest"
import { T0, descriptors, feedWorld, ingest, row } from "../feed/helpers"

// #9 复审：标的条件写成 COALESCE(dup_of, seq) IN (…) 用不上索引，罕见标的的查询在 30 万行上从 3 ms 退到 88 ms。
describe("成员的 dup_of 直接指向主条目、不成链（标的查询的 dup_of ∈ G 依赖它）", () => {
  it("两组并成一组、同批重复、同源重发之后，没有指向成员的 dup_of", async () => {
    const w = await feedWorld(descriptors(), { enrich: true })
    const T = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
    await ingest(w, "jin10", [row("a", { title: T, url: "https://a.example/1" }), row("a2", { title: T, url: "https://a.example/2" })], T0)
    await ingest(w, "weibo", [row("b", { title: `${T}。`, url: "https://a.example/3" })], T0 + 1000)
    await ingest(w, "hackernews", [row("c", { title: "完全无关的另一条新闻内容，用来造第二个组的主条目", url: "https://b.example/1" })], T0 + 2000)
    await ingest(w, "weibo", [row("d", { title: "完全无关的另一条新闻内容，用来造第二个组的主条目", url: "https://a.example/1?utm_source=x" })], T0 + 3000)
    const chained = await w.db.prepare("SELECT COUNT(*) AS n FROM items m JOIN items p ON p.seq = m.dup_of WHERE p.dup_of IS NOT NULL").get() as { n: number }
    expect(chained.n).toBe(0)
    const members = await w.db.prepare("SELECT COUNT(*) AS n FROM items WHERE dup_of IS NOT NULL").get() as { n: number }
    expect(members.n).toBeGreaterThan(0)
  })
})
