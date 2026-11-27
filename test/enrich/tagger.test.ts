import { describe, expect, it, vi } from "vitest"
import { T0, descriptors, feedWorld, ingest, row } from "../feed/helpers"
import impactData from "../../server/enrich/config/impact-types.json"
import { ERROR_BACKOFF_MS, MAX_TAG_ATTEMPTS, buildTagPrompt, createTagger, extractObjects, parseTagResponse, readTagCategories } from "#/enrich/tagger"
import type { LlmCall } from "#/enrich/llm"
import { LlmError } from "#/enrich/llm"
import { getImpactConfig, parseImpactConfig } from "#/enrich/impact"

const CN = getImpactConfig().cn.types.map(t => t.name)

describe("影响类型分类表（可配置，按市场分）", () => {
  it("a 股默认六类（公告 / 政策与监管 / 行业与题材 / 公司经营 / 外盘与宏观 / 市场情绪）加兜底的「其他」；美股、crypto 各有一份", () => {
    const cfg = getImpactConfig()
    expect(cfg.cn.types.map(t => t.name)).toEqual(["公告", "政策与监管", "行业与题材", "公司经营", "外盘与宏观", "市场情绪", "其他"])
    expect(cfg.us.types.length).toBeGreaterThanOrEqual(6)
    expect(cfg.crypto.types.length).toBeGreaterThanOrEqual(6)
    expect(cfg.cn.types[0].hint).toContain("业绩")
    expect(cfg.cn.types[0].hint).toContain("解禁")
  })

  it("校验：类型名重复、空、含引号、市场缺失都报错", () => {
    const mut = (f: (r: any) => void) => {
      const raw = JSON.parse(JSON.stringify(impactData))
      f(raw)
      return () => parseImpactConfig(raw)
    }
    expect(mut(r => r.markets.cn.types.push({ name: "公告", hint: "" }))).toThrow(/重复/)
    expect(mut(r => (r.markets.cn.types[0].name = " "))).toThrow(/1–20/)
    expect(mut(r => (r.markets.cn.types[0].name = "a\"b"))).toThrow(/引号/)
    expect(mut(r => delete r.markets.us)).toThrow(/us/)
    expect(mut(r => (r.markets.cn.types = []))).toThrow(/非空/)
  })
})

describe("批量标注的提示词", () => {
  it("带上该市场的分类表、序号化的标题，并声明方向不是涨跌预测", () => {
    const { system, user } = buildTagPrompt("cn", ["贵州茅台：控股股东拟增持", "国务院：发布新政策"])
    expect(user).toContain("市场：A 股")
    for (const name of CN) expect(user).toContain(`- ${name}`)
    expect(user).toContain("[0] 贵州茅台：控股股东拟增持")
    expect(user).toContain("[1] 国务院：发布新政策")
    expect(system).toContain("不是对价格涨跌的预测")
    expect(system).toContain("不要预测价格")
    expect(user).toContain("不要预测价格涨跌")
    expect(user).toContain("\"+\" 正面")
  })

  it("美股、crypto 用各自的表", () => {
    expect(buildTagPrompt("us", ["x"]).user).toContain("- 财报与指引")
    expect(buildTagPrompt("crypto", ["x"]).user).toContain("- 链上与资金流")
    expect(buildTagPrompt("us", ["x"]).user).not.toContain("- 公告")
  })

  it("标题里的换行与超长被收拾掉（不让一条标题冒充多条）", () => {
    const { user } = buildTagPrompt("cn", ["第一行\n[1] 假的第二条", "x".repeat(500)])
    expect(user).toContain("[0] 第一行 [1] 假的第二条")
    expect(user).not.toContain("x".repeat(201))
  })
})

describe("批量标注的解析（用夹具模拟模型返回）", () => {
  const good = `[{"i":0,"t":"公告","d":"+","g":"茅台控股股东拟增持","k":["白酒","消费"]},{"i":1,"t":"政策与监管","d":"0","g":"国务院发布新政","k":[]}]`

  it("干净的返回", () => {
    const m = parseTagResponse(good, 2, CN)
    expect(m.get(0)).toEqual({ impact: "公告", direction: "positive", gist: "茅台控股股东拟增持", themes: ["白酒", "消费"] })
    expect(m.get(1)).toEqual({ impact: "政策与监管", direction: "neutral", gist: "国务院发布新政", themes: [] })
  })

  it("夹带说明文字与代码块围栏", () => {
    expect(parseTagResponse(`好的，结果如下：\n\`\`\`json\n${good}\n\`\`\`\n希望有帮助`, 2, CN).size).toBe(2)
  })

  it("被截断的返回（最后一个对象没写完）：前面完整的照收，不整批作废", () => {
    const cut = `[{"i":0,"t":"公告","d":"+","g":"甲","k":["a"]},{"i":1,"t":"行业与题材","d":"-","g":"乙","k":["b"]},{"i":2,"t":"公告","d":"+","g":"丙被截`
    const m = parseTagResponse(cut, 3, CN)
    expect([...m.keys()]).toEqual([0, 1])
  })

  it("jSON 整体坏掉（不是 JSON、空串、只有道歉）：不抛错，返回空", () => {
    expect(parseTagResponse("抱歉，我无法完成这个请求", 3, CN).size).toBe(0)
    expect(parseTagResponse("", 3, CN).size).toBe(0)
    expect(parseTagResponse("[{{{ not json ]]", 3, CN).size).toBe(0)
    expect(parseTagResponse("null", 3, CN).size).toBe(0)
  })

  it("中间一个对象坏了：只丢那一个，其余照收", () => {
    const m = parseTagResponse(`[{"i":0,"t":"公告","d":"+"},{"i":1,"t":公告,"d":"+"},{"i":2,"t":"公告","d":"-"}]`, 3, CN)
    expect([...m.keys()]).toEqual([0, 2])
  })

  it("残缺的字段记 null，不补不造：影响类型不在表里 → null（保留其余）；方向认不出 → null；缺 g / k → null", () => {
    const m = parseTagResponse(`[{"i":0,"t":"瞎编的类型","d":"+","g":"甲","k":["a"]},{"i":1,"t":"公告","d":"也许","g":"乙"},{"i":2,"t":"公告"}]`, 3, CN)
    expect(m.get(0)).toEqual({ impact: null, direction: "positive", gist: "甲", themes: ["a"] })
    expect(m.get(1)).toEqual({ impact: "公告", direction: null, gist: "乙", themes: null })
    expect(m.get(2)).toEqual({ impact: "公告", direction: null, gist: null, themes: null })
  })

  it("四个字段全没有的条目等于没返回；序号越界、重复序号（先到先得）、非数字序号都丢掉", () => {
    const m = parseTagResponse(`[{"i":0},{"i":1,"t":"公告"},{"i":1,"t":"其他"},{"i":9,"t":"公告"},{"i":"x","t":"公告"},{"i":-1,"t":"公告"}]`, 3, CN)
    expect([...m.keys()]).toEqual([1])
    expect(m.get(1)?.impact).toBe("公告")
  })

  it("序号写成数字串也认；方向的几种写法都归一", () => {
    const m = parseTagResponse(`[{"i":"0","t":"公告","d":"利好"},{"i":1,"t":"公告","d":"bearish"},{"i":2,"t":"公告","d":"Neutral"}]`, 3, CN)
    expect([0, 1, 2].map(i => m.get(i)?.direction)).toEqual(["positive", "negative", "neutral"])
  })

  it("题材去空、去重、截长、最多 5 个；要点最长 80 字；字符串里的花括号不会弄乱解析", () => {
    const m = parseTagResponse(JSON.stringify([{ i: 0, t: "公告", d: "0", g: `含{花括号}与"引号"的要点${"长".repeat(100)}`, k: ["a", "a", " ", "b", "c", "d", "e", "f", 3] }]), 1, CN)
    expect(m.get(0)!.themes).toEqual(["a", "b", "c", "d", "e"])
    expect(m.get(0)!.gist!.length).toBe(80)
    expect(m.get(0)!.gist).toContain("{花括号}")
  })

  it("整体包在对象里（{\"results\":[…]}）也能取出", () => {
    expect(parseTagResponse(`{"results":${good}}`, 2, CN).size).toBe(2)
  })

  it("extractObjects：转义的引号不会提前结束字符串", () => {
    expect(extractObjects(String.raw`[{"i":0,"g":"他说\"{好}\""}]`)).toEqual([{ i: 0, g: "他说\"{好}\"" }])
  })
})

/** 起一个有富化器的库，写进若干财经条目（各自不同的标题，免得被并成一组）。 */
async function world() {
  const w = await feedWorld(descriptors([{ id: "cls-telegraph", name: "财联社电报", category: "finance", builtin: true, enabled: true }]), { enrich: true })
  return w
}
const titles = (n: number, prefix = "快讯") => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, { title: `${prefix}${i}：这是第${i}条互不相同且足够长的测试快讯内容 ${"甲乙丙丁戊己庚辛"[i % 8]}${i * 7919}`, url: `https://x.example/${prefix}/${i}` }))
const reply = (items: Record<string, unknown>[]) => JSON.stringify(items)

describe("批量标注一轮：落库、失败计数、没配模型", () => {
  it("没配模型（没有 tagger）：条目照常入库，tags 是 null，不报错", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", titles(3), T0)
    const res = await w.service.query({})
    expect(res.items).toHaveLength(3)
    for (const i of res.items) expect(i.tags).toBeNull()
  })

  it("标完写回库，查询里每条带 tags；一次请求打包多条", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", titles(3), T0)
    const calls: string[] = []
    const llm: LlmCall = async (req) => {
      calls.push(req.user)
      return reply([{ i: 0, t: "公告", d: "+", g: "甲", k: ["x"] }, { i: 1, t: "公告", d: "-", g: "乙", k: [] }, { i: 2, t: "市场情绪", d: "0", g: "丙", k: ["y", "z"] }])
    }
    const tagger = createTagger({ store: w.enricher.store, llm, sourceIds: async () => null })
    expect(await tagger.run()).toEqual({ calls: 1, tagged: 3, failed: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("[0]")
    expect(calls[0]).toContain("[2]")
    const res = await w.service.query({})
    // 新的先标：序号 0 是 seq 最大的那条
    const bySeq = new Map(res.items.map(i => [i.seq, i]))
    expect(bySeq.get(3)!.tags).toEqual({ impact: "公告", direction: "positive", gist: "甲", themes: ["x"] })
    expect(bySeq.get(2)!.tags).toEqual({ impact: "公告", direction: "negative", gist: "乙", themes: [] })
    expect(bySeq.get(1)!.tags).toEqual({ impact: "市场情绪", direction: "neutral", gist: "丙", themes: ["y", "z"] })
  })

  it("模型少返回了一条：那条 tags 仍是 null、失败计数加一；返回残缺的字段是 null；下一轮重试，试满上限后放弃", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", titles(2), T0)
    // 第一次只返回了 0 号，且没有 g、k；之后一直什么都不返回
    let n = 0
    const llm = vi.fn<LlmCall>(async () => (++n === 1 ? reply([{ i: 0, t: "公告", d: "+" }]) : "[]"))
    const tagger = createTagger({ store: w.enricher.store, llm, sourceIds: async () => null })
    expect(await tagger.run()).toMatchObject({ tagged: 1, failed: 1 })
    let res = await w.service.query({})
    expect(res.items.map(i => i.tags)).toEqual([{ impact: "公告", direction: "positive", gist: null, themes: null }, null])
    // 再跑：只剩没标成的那条
    for (let i = 1; i < MAX_TAG_ATTEMPTS; i++) await tagger.run()
    expect(llm).toHaveBeenCalledTimes(MAX_TAG_ATTEMPTS)
    expect(await tagger.run()).toEqual({ calls: 0, tagged: 0, failed: 0 })
    expect(await w.enricher.store.tagCounts(MAX_TAG_ATTEMPTS)).toEqual({ tagged: 1, pending: 0, gaveUp: 1 })
    res = await w.service.query({})
    expect(res.items[1].tags).toBeNull()
  })

  it("模型返回整个坏掉：不崩，字段保持 null，失败计数加一", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", titles(2), T0)
    const tagger = createTagger({ store: w.enricher.store, llm: async () => "抱歉，我无法完成这个请求", sourceIds: async () => null })
    expect(await tagger.run()).toMatchObject({ tagged: 0, failed: 2 })
    expect((await w.service.query({})).items.map(i => i.tags)).toEqual([null, null])
  })

  it("模型接口出错（限流、网络）：整轮中止、不计失败次数、退避一段时间，之后恢复", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", titles(2), T0)
    let now = T0
    let fail = true
    const llm = vi.fn<LlmCall>(async () => {
      if (fail) throw new LlmError("模型接口返回 HTTP 429")
      return reply([{ i: 0, t: "公告", d: "+", g: "甲", k: [] }, { i: 1, t: "公告", d: "+", g: "乙", k: [] }])
    })
    const tagger = createTagger({ store: w.enricher.store, llm, sourceIds: async () => null, clock: () => now })
    expect(await tagger.run()).toMatchObject({ calls: 1, tagged: 0, error: expect.stringContaining("429") })
    expect(await tagger.run()).toEqual({ calls: 0, tagged: 0, failed: 0 }) // 退避中，没有调用
    expect(llm).toHaveBeenCalledTimes(1)
    expect(await w.enricher.store.tagCounts(MAX_TAG_ATTEMPTS)).toMatchObject({ pending: 2, gaveUp: 0 }) // 没计失败
    fail = false
    now += ERROR_BACKOFF_MS
    expect(await tagger.run()).toMatchObject({ calls: 1, tagged: 2 })
  })

  it("每轮最多调用 maxBatchesPerRun 次，每次最多 batchSize 条，新的先标；drain 追完全部", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", titles(5), T0)
    const seen: number[] = []
    const llm: LlmCall = async (req) => {
      const n = (req.user.match(/^\[\d+\]/gm) ?? []).length
      seen.push(n)
      return reply(Array.from({ length: n }, (_, i) => ({ i, t: "其他", d: "0", g: "g", k: [] })))
    }
    const tagger = createTagger({ store: w.enricher.store, llm, sourceIds: async () => null, batchSize: 2, maxBatchesPerRun: 2 })
    expect(await tagger.run()).toMatchObject({ calls: 2, tagged: 4 })
    expect(seen).toEqual([2, 2])
    expect((await w.enricher.store.tagCounts(MAX_TAG_ATTEMPTS)).pending).toBe(1)
    expect(await tagger.drain()).toMatchObject({ tagged: 1 })
    expect((await w.enricher.store.tagCounts(MAX_TAG_ATTEMPTS)).pending).toBe(0)
  })

  it("只标组的主条目；成员行的 tags 读的是主条目的；被规则层过滤的不标", async () => {
    const w = await world()
    const T = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
    await ingest(w, "cls-telegraph", [row("a", { title: T, url: "https://a.example/1" }), row("spam", { title: "加微信领取今日牛股名单，限时免费，明日必涨停", url: "https://a.example/s" })], T0)
    await ingest(w, "jin10", [row("b", { title: `${T}。`, url: "https://a.example/2" })], T0 + 1000)
    const prompts: string[] = []
    const llm: LlmCall = async (req) => {
      prompts.push(req.user)
      return reply([{ i: 0, t: "政策与监管", d: "0", g: "国家数据局拓展词元服务", k: ["数据要素"] }])
    }
    const tagger = createTagger({ store: w.enricher.store, llm, sourceIds: async () => null })
    expect(await tagger.run()).toMatchObject({ calls: 1, tagged: 1 })
    expect(prompts[0].match(/^\[\d+\]/gm)).toHaveLength(1) // 只有主条目一条，垃圾和成员都没发
    const all = await w.service.query({ expand: "1", includeFiltered: "1" })
    const byItem = new Map(all.items.map(i => [i.itemId, i]))
    expect(byItem.get("a")!.tags).toMatchObject({ impact: "政策与监管" })
    expect(byItem.get("b")!.tags).toEqual(byItem.get("a")!.tags) // 成员行拿主条目的
    expect(byItem.get("spam")!.tags).toBeNull()
    expect(byItem.get("spam")!.filterReason).toBe("stock_tout")
  })

  it("来源范围：只标指定来源的，或标题里识别出了标的的；没限定（null）就全标", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", titles(1, "财经"), T0)
    await ingest(w, "hackernews", titles(1, "科技"), T0)
    await ingest(w, "hackernews", [row("nv", { title: "英伟达（NVDA）发布新一代芯片，数据中心业务大增，市场反应积极", url: "https://x.example/nv" })], T0)
    const prompts: string[] = []
    const llm: LlmCall = async (req) => {
      prompts.push(req.user)
      const n = (req.user.match(/^\[\d+\]/gm) ?? []).length
      return reply(Array.from({ length: n }, (_, i) => ({ i, t: "其他", d: "0", g: "g", k: [] })))
    }
    const tagger = createTagger({ store: w.enricher.store, llm, sourceIds: async () => ["cls-telegraph"] })
    await tagger.run()
    const text = prompts.join("\n")
    expect(text).toContain("财经0")
    expect(text).toContain("英伟达")
    expect(text).not.toContain("科技0")
  })

  it("按条目的市场选分类表：有美股标的的用美股表，没标的的 cn 来源用 A 股表", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", [row("us", { title: "英伟达（NVDA）财报超预期，数据中心收入同比大增，盘后股价上涨超过百分之五", url: "https://x.example/1" })], T0)
    await ingest(w, "cls-telegraph", titles(1, "国内"), T0 + 1000)
    const prompts: string[] = []
    const llm: LlmCall = async (req) => {
      prompts.push(req.user)
      return reply([{ i: 0, t: "其他", d: "0", g: "g", k: [] }])
    }
    await createTagger({ store: w.enricher.store, llm, sourceIds: async () => null }).run()
    expect(prompts).toHaveLength(2)
    expect(prompts.some(p => p.includes("市场：美股") && p.includes("英伟达"))).toBe(true)
    expect(prompts.some(p => p.includes("市场：A 股") && p.includes("国内0"))).toBe(true)
  })

  it("并发触发只调一次模型（单飞）", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", titles(2), T0)
    const llm = vi.fn<LlmCall>(async () => reply([{ i: 0, t: "其他", d: "0", g: "g", k: [] }, { i: 1, t: "其他", d: "0", g: "g", k: [] }]))
    const tagger = createTagger({ store: w.enricher.store, llm, sourceIds: async () => null })
    await Promise.all([tagger.run(), tagger.run(), tagger.run()])
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it("重标：resetTags 清掉标注与失败计数，回到待标注", async () => {
    const w = await world()
    await ingest(w, "cls-telegraph", titles(2), T0)
    const tagger = createTagger({ store: w.enricher.store, llm: async () => reply([{ i: 0, t: "公告", d: "+", g: "g", k: [] }, { i: 1, t: "公告", d: "+", g: "g", k: [] }]), sourceIds: async () => null })
    await tagger.run()
    expect(await w.enricher.store.resetTags()).toBe(2)
    expect((await w.service.query({})).items.every(i => i.tags === null)).toBe(true)
    expect(await w.enricher.store.tagCounts(MAX_TAG_ATTEMPTS)).toEqual({ tagged: 0, pending: 2, gaveUp: 0 })
  })
})

describe("批量标注的来源范围配置", () => {
  it("默认 finance 与 财经；* 不限；自定义逗号分隔、不分大小写", () => {
    expect(readTagCategories({})).toEqual(["finance", "财经"])
    expect(readTagCategories({ ENRICH_TAG_CATEGORIES: "*" })).toBeNull()
    expect(readTagCategories({ ENRICH_TAG_CATEGORIES: " Finance, 社区 " })).toEqual(["finance", "社区"])
  })
})
