import { describe, expect, it, vi } from "vitest"
import { T0, descriptors, feedWorld, ingest, row } from "../feed/helpers"
import { DEEP_VERSION, DeepNotFound, TITLE_BASIS_RETRY_MS, buildDeepPrompt, createDeepReader, extractPageText, parseDeepResponse, titleFingerprint } from "#/enrich/deep"
import { LlmError } from "#/enrich/llm"
import type { LlmCall } from "#/enrich/llm"
import { createFeedService } from "#/feed/service"
import { InputError } from "#/registry/spec"

const GOOD = JSON.stringify({ summary: "国家数据局提出拓展词元服务场景。", keyPoints: ["健全计量计费", "质量测评标准"], entities: ["国家数据局"], caveats: ["没有原文，只依据标题"] })
const TITLE = "国家数据局：积极拓展词元服务应用场景 健全词元计量计费、质量测评等标准规范"
const PAGE = `<html><head><script>var x = 1</script></head><body><nav>导航 首页 财经</nav><article>${"<p>国家数据局今日发布通知，提出积极拓展词元服务的应用场景，并健全词元计量计费与质量测评等标准规范，相关细则将另行公布。</p>".repeat(4)}</article><footer>版权所有</footer></body></html>`

async function setup(opts: { llm?: LlmCall | null, fetchPage?: (u: string) => Promise<string>, clock?: () => number } = {}) {
  const w = await feedWorld(descriptors(), { enrich: true })
  await ingest(w, "jin10", [row("a", { title: TITLE, url: "https://news.example.com/p/1" })], T0)
  await ingest(w, "weibo", [row("b", { title: `${TITLE}。`, url: "https://other.example.com/x" })], T0 + 1000)
  const reader = createDeepReader({ store: w.enricher.store, llm: opts.llm === undefined ? async () => GOOD : opts.llm, model: "test-model", fetchPage: opts.fetchPage, clock: opts.clock ?? (() => T0 + 5000) })
  return { w, reader }
}

describe("按需深读：结果缓存进库，第二次直接读缓存", () => {
  it("第一次调模型并缓存，第二次命中缓存、不再调模型；新建读取器（重启之后）也命中", async () => {
    const llm = vi.fn<LlmCall>(async () => GOOD)
    const { w, reader } = await setup({ llm })
    const first = await reader.read(1)
    expect(first).toMatchObject({ seq: 1, status: "ok", cached: false, basis: "title", model: "test-model", createdAt: T0 + 5000 })
    expect(first.deep).toEqual({ summary: "国家数据局提出拓展词元服务场景。", keyPoints: ["健全计量计费", "质量测评标准"], entities: ["国家数据局"], caveats: ["没有原文，只依据标题"] })
    expect(llm).toHaveBeenCalledTimes(1)

    const second = await reader.read(1)
    expect(second).toMatchObject({ status: "ok", cached: true, model: "test-model" })
    expect(second.deep).toEqual(first.deep)
    expect(llm).toHaveBeenCalledTimes(1)

    const row = await w.db.prepare("SELECT seq, model, basis FROM item_deep").all() as { seq: number }[]
    expect(row).toHaveLength(1)

    // 另起一个读取器（进程重启）：读的是库里的缓存
    const llm2 = vi.fn<LlmCall>(async () => GOOD)
    const again = createDeepReader({ store: w.enricher.store, llm: llm2, model: "test-model" })
    expect(await again.read(1)).toMatchObject({ cached: true })
    expect(llm2).not.toHaveBeenCalled()
  })

  it("缓存命中时即使现在没配模型也能读到", async () => {
    const { w, reader } = await setup()
    await reader.read(1)
    const noModel = createDeepReader({ store: w.enricher.store, llm: null, model: null })
    expect(await noModel.read(1)).toMatchObject({ status: "ok", cached: true })
  })

  it("没配模型：status = unavailable、deep 是 null，说明原因，不报错、不缓存", async () => {
    const { w, reader } = await setup({ llm: null })
    const r = await reader.read(1)
    expect(r).toMatchObject({ seq: 1, status: "unavailable", cached: false, deep: null, basis: null })
    expect(r.message).toContain("ENRICH_LLM")
    expect(((await w.db.prepare("SELECT COUNT(*) AS n FROM item_deep").get()) as { n: number }).n).toBe(0)
  })

  it("seq 不存在：抛 DeepNotFound（服务层是 404）；seq 格式不对是 400", async () => {
    const { w, reader } = await setup()
    await expect(reader.read(999)).rejects.toBeInstanceOf(DeepNotFound)
    const service = createFeedService({ store: w.feedStore, describe: async () => descriptors(), deep: reader })
    await expect(service.deep("999")).rejects.toMatchObject({ status: 404 })
    for (const bad of ["abc", "0", "-1", "1.5", undefined, ""]) await expect(service.deep(bad), String(bad)).rejects.toBeInstanceOf(InputError)
    expect((await service.deep("1")).status).toBe("ok")
    expect((await service.deep(1)).cached).toBe(true)
  })

  it("读到了原文页面：prompt 里有原文，basis = page；抓不到或太短：只用标题，basis = title", async () => {
    const prompts: string[] = []
    const llm: LlmCall = async (req) => {
      prompts.push(req.user)
      return GOOD
    }
    const a = await setup({ llm, fetchPage: async () => PAGE })
    expect(await a.reader.read(1)).toMatchObject({ basis: "page" })
    expect(prompts[0]).toContain("国家数据局今日发布通知")
    expect(prompts[0]).not.toContain("var x = 1")
    expect(prompts[0]).not.toContain("导航")

    const b = await setup({ llm, fetchPage: async () => {
      throw new Error("HTTP 403")
    } })
    expect(await b.reader.read(1)).toMatchObject({ status: "ok", basis: "title" })
    expect(prompts[1]).toContain("没有抓到")

    const c = await setup({ llm, fetchPage: async () => "<html><body><p>请开启 JavaScript</p></body></html>" })
    expect(await c.reader.read(1)).toMatchObject({ basis: "title" })
  })

  it("prompt 带同组其他报道的标题、识别出的标的，并要求不做涨跌预测、不补材料里没有的", async () => {
    const prompts: { system?: string, user: string }[] = []
    const llm: LlmCall = async (req) => {
      prompts.push(req)
      return GOOD
    }
    const { reader } = await setup({ llm })
    await reader.read(1)
    expect(prompts[0].user).toContain("同一事件的其他报道标题")
    expect(prompts[0].user).toContain(TITLE)
    expect(prompts[0].system).toContain("不要做任何涨跌预测")
    expect(prompts[0].system).toContain("不要补充")
  })

  it("模型出错或返回解析不出来：status = error，不缓存，下次可以重试", async () => {
    let mode: "throw" | "junk" | "ok" = "throw"
    const { w, reader } = await setup({
      llm: async () => {
        if (mode === "throw") throw new LlmError("模型接口返回 HTTP 500")
        return mode === "junk" ? "抱歉，无法处理" : GOOD
      },
    })
    expect(await reader.read(1)).toMatchObject({ status: "error", deep: null })
    mode = "junk"
    expect(await reader.read(1)).toMatchObject({ status: "error", deep: null })
    expect(((await w.db.prepare("SELECT COUNT(*) AS n FROM item_deep").get()) as { n: number }).n).toBe(0)
    mode = "ok"
    expect(await reader.read(1)).toMatchObject({ status: "ok", cached: false })
  })

  it("同一条并发点开只调一次模型", async () => {
    const llm = vi.fn<LlmCall>(async () => GOOD)
    const { reader } = await setup({ llm })
    const rs = await Promise.all([reader.read(1), reader.read(1), reader.read(1)])
    expect(rs.every(r => r.status === "ok")).toBe(true)
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it("缓存里的 JSON 坏了：当作没有，重新读", async () => {
    const { w, reader } = await setup()
    await w.enricher.store.saveDeep({ seq: 1, result: "{坏了", model: "m", basis: "title", createdAt: T0, version: DEEP_VERSION, titleHash: titleFingerprint(TITLE) })
    expect(await reader.read(1)).toMatchObject({ status: "ok", cached: false })
  })
})

describe("独立审 M4：缓存带版本、标题指纹与重试间隔，不把降级结果永久固化", () => {
  it("依据只是标题（抓原文失败）：重试间隔之内读缓存；过了再抓一次，抓到了就升成 page 并从此永久缓存", async () => {
    let now = T0 + 5000
    let pageOk = false
    const llm = vi.fn<LlmCall>(async () => GOOD)
    const fetchPage = vi.fn(async () => {
      if (!pageOk) throw new Error("HTTP 429")
      return PAGE
    })
    const { reader } = await setup({ llm, fetchPage, clock: () => now })
    expect(await reader.read(1)).toMatchObject({ basis: "title", cached: false })
    expect(fetchPage).toHaveBeenCalledTimes(1)
    now += TITLE_BASIS_RETRY_MS - 1
    expect(await reader.read(1)).toMatchObject({ basis: "title", cached: true })
    expect(llm).toHaveBeenCalledTimes(1)
    // 过了间隔，原文这次抓得到
    pageOk = true
    now += 2
    const retried = await reader.read(1)
    expect(retried).toMatchObject({ basis: "page", cached: false, status: "ok" })
    expect(llm).toHaveBeenCalledTimes(2)
    // 依据是原文的永远有效
    now += 100 * TITLE_BASIS_RETRY_MS
    expect(await reader.read(1)).toMatchObject({ basis: "page", cached: true })
    expect(llm).toHaveBeenCalledTimes(2)
  })

  it("重试了仍抓不到：新的降级结果重新计时；重试时模型出错：仍给旧结果，不用错误换掉它", async () => {
    let now = T0 + 5000
    let broken = false
    const llm = vi.fn<LlmCall>(async () => {
      if (broken) throw new LlmError("模型接口返回 HTTP 500")
      return GOOD
    })
    const { reader } = await setup({ llm, fetchPage: async () => {
      throw new Error("HTTP 403")
    }, clock: () => now })
    await reader.read(1)
    now += TITLE_BASIS_RETRY_MS
    expect(await reader.read(1)).toMatchObject({ basis: "title", cached: false })
    expect(llm).toHaveBeenCalledTimes(2)
    now += TITLE_BASIS_RETRY_MS - 1
    expect(await reader.read(1)).toMatchObject({ cached: true }) // 计时是从第二次开始的
    now += 2
    broken = true
    expect(await reader.read(1)).toMatchObject({ status: "ok", cached: true, basis: "title" })
  })

  it("没有可重试的路径（没配抓取、或这条没有链接）：依据是标题的缓存就是最终的，不重复调模型", async () => {
    let now = T0 + 5000
    const llm = vi.fn<LlmCall>(async () => GOOD)
    const { reader } = await setup({ llm, clock: () => now }) // 没有 fetchPage
    await reader.read(1)
    now += 1000 * TITLE_BASIS_RETRY_MS
    expect(await reader.read(1)).toMatchObject({ cached: true })
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it("标题变了（retitle）：缓存按标题指纹失效，按新标题重读", async () => {
    const prompts: string[] = []
    const llm: LlmCall = async (req) => {
      prompts.push(req.user)
      return GOOD
    }
    const { w, reader } = await setup({ llm })
    await reader.read(1)
    expect(await reader.read(1)).toMatchObject({ cached: true })
    await ingest(w, "jin10", [row("a", { title: "国家数据局：全面放开词元服务应用场景，细则下月公布", url: "https://news.example.com/p/1" })], T0 + 60_000)
    const after = await reader.read(1)
    expect(after).toMatchObject({ status: "ok", cached: false })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("全面放开词元服务应用场景")
    expect(await reader.read(1)).toMatchObject({ cached: true })
  })

  it("版本不同（提示词 / 字段改过）或老数据没有版本与指纹：不算命中", async () => {
    const llm = vi.fn<LlmCall>(async () => GOOD)
    const { w, reader } = await setup({ llm })
    const base = { seq: 1, result: GOOD, model: "old", basis: "page", createdAt: T0 }
    await w.enricher.store.saveDeep({ ...base, version: DEEP_VERSION - 1, titleHash: titleFingerprint(TITLE) })
    expect(await reader.read(1)).toMatchObject({ cached: false, model: "test-model" })
    await w.enricher.store.saveDeep({ ...base, version: DEEP_VERSION, titleHash: null })
    expect(await reader.read(1)).toMatchObject({ cached: false })
    expect(llm).toHaveBeenCalledTimes(2)
  })

  it("老库的 item_deep（没有 version、title_hash 两列）启动时补上列，老行当作没缓存", async () => {
    const { createDatabase } = await import("db0")
    const sqlite = (await import("db0/connectors/better-sqlite3")).default
    const { ObservationStore } = await import("#/collector/store")
    const db = createDatabase(sqlite({ name: ":memory:" }))
    await db.exec(`CREATE TABLE item_deep (seq INTEGER PRIMARY KEY, result TEXT NOT NULL, model TEXT NOT NULL, basis TEXT NOT NULL, created_at INTEGER NOT NULL)`)
    await db.exec(`INSERT INTO item_deep VALUES (1, '{"summary":"旧"}', 'old', 'title', ${T0})`)
    await new ObservationStore(db).init()
    await new ObservationStore(db).init()
    const cols = ((await db.prepare("PRAGMA table_info(item_deep)").all()) as { name: string }[]).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining(["version", "title_hash"]))
    const { EnrichStore } = await import("#/enrich/store")
    expect(await new EnrichStore(db).getDeep(1)).toMatchObject({ version: 0, titleHash: null })
  })
})

describe("深读的解析与原文抽取", () => {
  it("parseDeepResponse：没有 summary 不凑数；字段缺失给空数组；要点至多 6 条", () => {
    expect(parseDeepResponse("无关的话")).toBeNull()
    expect(parseDeepResponse(`{"keyPoints":["a"]}`)).toBeNull()
    expect(parseDeepResponse(`前言 {"summary":"甲"} 后记`)).toEqual({ summary: "甲", keyPoints: [], entities: [], caveats: [] })
    expect(parseDeepResponse(JSON.stringify({ summary: "甲", keyPoints: ["1", "2", "3", "4", "5", "6", "7", 8] }))!.keyPoints).toHaveLength(6)
  })

  it("extractPageText：优先 article 里的段落，去掉脚本、导航、页脚；超长截断", () => {
    const text = extractPageText(PAGE)
    expect(text).toContain("国家数据局今日发布通知")
    expect(text).not.toContain("版权所有")
    expect(extractPageText(PAGE, 50).length).toBe(50)
  })

  it("buildDeepPrompt：没有原文时明说", () => {
    const { user } = buildDeepPrompt({ title: "t", cleanTitle: "t", symbols: [] } as any, [], null)
    expect(user).toContain("没有抓到")
  })
})
