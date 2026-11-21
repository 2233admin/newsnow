import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { Actions, Caller } from "#/actions/actions"
import type { FeedService } from "#/feed/service"
import { InputError } from "#/registry/spec"

/**
 * MCP 入口（#2186）：工具 = 查询 + 全部动作 + 撤销。每个工具都只是调用 feed 服务或动作层（server/actions/），
 * 不带自己的业务逻辑；HTTP 入口调的是同一套函数，所以两边的校验、审计、撤销完全一致。
 * 一次请求一个 McpServer（无状态），调用方（caller）来自请求：入口固定 mcp，名字取自 X-Actor 头。
 */

export const MCP_SERVER_INFO = { name: "newsnow-katana", version: "0.1.0" }

const time = z.union([z.string(), z.number()]).describe("毫秒时间戳，或 ISO 8601 日期串")
const list = z.union([z.string(), z.array(z.string())])

const spec = z.object({
  kind: z.enum(["rss", "rsshub", "json", "rule"]).describe("rss：RSS/Atom 地址；rsshub：RSSHub 路由；json：JSON API + 字段映射；rule：CSS 选择器规则"),
  url: z.string().optional().describe("rss / json / rule 的地址（http 或 https）"),
  route: z.string().optional().describe("rsshub 的路由，以 / 开头，如 /github/trending/daily"),
  limit: z.number().int().optional().describe("rsshub：最多取几条（1–100）"),
  itemsPath: z.string().optional().describe("json：条目数组所在的点路径，空串表示响应本身就是数组"),
  item: z.string().optional().describe("rule：每条新闻对应的元素的 CSS 选择器"),
  fields: z.object({
    title: z.string(),
    url: z.string(),
    id: z.string().optional(),
    pubDate: z.string().optional(),
  }).optional().describe("json / rule：字段映射，点路径或 选择器@属性"),
}).describe("订阅源配置；不确定怎么写时先用 preview_source 传 url 自动识别")

const slug = z.string().describe("用户源的 slug（不带 user: 前缀）")

const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] })

/** 校验类错误（InputError）当作工具的失败结果返回给模型，让它能据此改参数重试；其余错误抛出去。 */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn())
  } catch (e) {
    if (e instanceof InputError) return { content: [{ type: "text", text: `${e.message}（HTTP ${e.status}）` }], isError: true }
    throw e
  }
}

export interface McpDeps {
  feed: FeedService
  actions: Actions
  caller: Caller
}

export function createMcpServer({ feed, actions, caller }: McpDeps) {
  const server = new McpServer(MCP_SERVER_INFO)
  const read = { readOnlyHint: true } as const
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const

  server.registerTool("query_feed", {
    title: "查询新闻流",
    description: "查询已入库的新闻，最新的在前。按时间范围、来源、分类、关键词筛选，游标分页；返回 items、nextCursor（null 表示到底）与 latestSeq。"
      + "symbol（标的）筛选尚未实装，给了会返回空并在 unimplemented 里标明。",
    inputSchema: {
      from: time.optional().describe("排序时间下限（含）"),
      to: time.optional().describe("排序时间上限（不含）"),
      since: time.optional().describe("只要入库时间不早于它的（拉新）"),
      source: list.optional().describe("来源 id；带 * 的是前缀，如 user:* 是全部用户源"),
      category: list.optional().describe("分类，如 finance、tech、china，或用户源自己填的分类"),
      q: z.string().optional().describe("关键词，空白分隔，标题须包含每一个词"),
      symbol: list.optional().describe("标的代码（未实装）"),
      limit: z.number().int().min(1).max(200).optional().describe("每页条数，默认 50"),
      cursor: z.string().optional().describe("上一页返回的 nextCursor，原样传回"),
      includeInactive: z.boolean().optional().describe("含停用与已删除的源的历史条目"),
    },
    annotations: read,
  }, args => run(() => feed.query(args)))

  server.registerTool("list_sources", {
    title: "列出用户订阅源",
    description: "全部用户订阅源及各自的采集健康（最近成功时间、连续失败次数、最近错误）。",
    annotations: read,
  }, () => run(async () => ({ sources: await actions.list() })))

  server.registerTool("preview_source", {
    title: "预览订阅源",
    description: "不保存，只试抓：传 url 自动识别类型（RSS、JSON、网页里声明的 RSS，/路由 与 rsshub://路由 按 RSSHub），或传 spec 试手写的配置。返回识别出的 spec、建议名称与前 5 条。",
    inputSchema: { url: z.string().optional(), spec: spec.optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, args => run(() => actions.preview(args)))

  server.registerTool("add_source", {
    title: "新增订阅源",
    description: "保存一个用户订阅源，下一轮采集（至多一分钟内）开始抓。返回新源与 auditId，auditId 可交给 undo 撤销。",
    inputSchema: {
      name: z.string(),
      spec,
      category: z.string().optional().describe("分类，可空"),
      interval: z.number().int().optional().describe("刷新间隔，毫秒，120000 到 86400000，默认 600000"),
      enabled: z.boolean().optional().describe("默认 true"),
      slug: z.string().optional().describe("不给则按名称生成"),
    },
    annotations: write,
  }, args => run(async () => {
    const { value, auditId } = await actions.addSource(caller, args)
    return { ...value, auditId }
  }))

  server.registerTool("remove_source", {
    title: "删除订阅源",
    description: "删配置；已入库的条目保留。可用 undo 加回来。",
    inputSchema: { slug },
    annotations: { ...write, destructiveHint: true },
  }, ({ slug }) => run(async () => ({ ok: true, auditId: (await actions.removeSource(caller, slug)).auditId })))

  server.registerTool("update_source", {
    title: "修改订阅源",
    description: "部分更新：给哪项改哪项（name、spec、category、interval、enabled）。",
    inputSchema: {
      slug,
      name: z.string().optional(),
      spec: spec.optional(),
      category: z.string().optional(),
      interval: z.number().int().optional(),
      enabled: z.boolean().optional(),
    },
    annotations: write,
  }, ({ slug, ...patch }) => run(async () => {
    const { value, auditId } = await actions.updateSource(caller, slug, patch)
    return { ...value, auditId }
  }))

  server.registerTool("set_source_enabled", {
    title: "启停订阅源",
    description: "停用的源不再采集、历史条目默认不出现在新闻流里。",
    inputSchema: { slug, enabled: z.boolean() },
    annotations: write,
  }, ({ slug, enabled }) => run(async () => {
    const { value, auditId } = await actions.setEnabled(caller, slug, enabled)
    return { ...value, auditId }
  }))

  server.registerTool("set_source_category", {
    title: "改订阅源分类",
    description: "分类按注册表现算：改完后该源的全部历史条目立刻归到新分类。空串表示不分类。",
    inputSchema: { slug, category: z.string() },
    annotations: write,
  }, ({ slug, category }) => run(async () => {
    const { value, auditId } = await actions.setCategory(caller, slug, category)
    return { ...value, auditId }
  }))

  server.registerTool("set_source_interval", {
    title: "改订阅源刷新间隔",
    description: "毫秒，120000（2 分钟）到 86400000（24 小时）。",
    inputSchema: { slug, interval: z.number().int() },
    annotations: write,
  }, ({ slug, interval }) => run(async () => {
    const { value, auditId } = await actions.setInterval(caller, slug, interval)
    return { ...value, auditId }
  }))

  server.registerTool("import_sources_opml", {
    title: "导入订阅源（OPML）",
    description: "导入 OPML 文本。带 katana:slug 的按 slug 对应：已存在时 skip（默认）保留现有，replace 用文件里的覆盖；其余按地址去重。一次导入一条审计，撤销时整批回滚。",
    inputSchema: { opml: z.string(), onConflict: z.enum(["skip", "replace"]).optional() },
    annotations: write,
  }, ({ opml, onConflict }) => run(async () => {
    const { value, auditId } = await actions.importOpml(caller, opml, onConflict ?? "skip")
    return { ...value, auditId }
  }))

  server.registerTool("export_sources_opml", {
    title: "导出订阅源（OPML）",
    description: "导出全部用户订阅源（含停用的）为 OPML 文本。",
    annotations: read,
  }, () => run(() => actions.exportOpml()))

  server.registerTool("list_audit", {
    title: "审计记录",
    description: "改动审计，最新的在前：谁（入口与调用方名）、何时、改了什么（每个源改动前后的配置）。undoneBy 非空表示已被撤销。",
    inputSchema: { limit: z.number().int().min(1).max(200).optional(), before: z.number().int().optional().describe("上一页最后一条的 id") },
    annotations: read,
  }, ({ limit, before }) => run(async () => ({ records: await actions.listAudit(limit ?? 50, before) })))

  server.registerTool("undo", {
    title: "撤销一次改动",
    description: "按审计记录的 id 撤销。现状必须正好是那条记录改出来的状态；之后又被改过的会拒绝，请先撤销后面的。撤销本身也写审计，撤销一条撤销记录就是重做。",
    inputSchema: { auditId: z.number().int() },
    annotations: { ...write, destructiveHint: true },
  }, ({ auditId }) => run(async () => (await actions.undo(caller, auditId)).value))

  return server
}
