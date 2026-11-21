import { Buffer } from "node:buffer"
import { XMLParser } from "fast-xml-parser"
import { InputError } from "./spec"
import type { StoredUserSource } from "./store"

/**
 * OPML 2.0 导入导出（#2185）。选型：
 * - 标准部分照 OPML 2.0（http://opml.org/spec2.opml ，读取日期 2026-11-21）与 RSS 阅读器的通行做法：
 *   `<outline type="rss" text title xmlUrl>`，分类用外层的文件夹 outline（text = 分类名）。
 *   这样导出的文件能直接导入 Feedly、Inoreader、NetNewsWire 等。
 * - 标准装不下的信息（slug、刷新间隔、启停、RSSHub 路由、JSON 与规则类的整份配置）放在带命名空间的扩展属性里：
 *   OPML 2.0 明确允许 outline 带任意其他属性（规范「Attributes of outline」一节）。
 *   命名空间 `xmlns:katana`，属性 katana:slug / katana:interval / katana:enabled / katana:kind / katana:spec。
 *   katana:spec 是 JSON（与库里存的同一份）；不认识扩展的阅读器会忽略它们。
 * - RSS 类只用标准属性 + katana:slug/interval/enabled；RSSHub 类把 xmlUrl 写成完整的 RSSHub 地址（阅读器可直接订），
 *   路由本身在 katana:spec 里；JSON 与规则类没有对应的标准类型，写成 type="link" + url（规范里 link 类型的属性）。
 */

export const OPML_NS = "https://github.com/2233admin/newsnow/ns/opml"
/** 导入的 OPML 最大字节数。待定：200 个源（MAX_USER_SOURCES）每个约 0.5 KB，1 MiB 绰绰有余。 */
export const MAX_OPML_BYTES = 1024 * 1024

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function attrs(pairs: [string, string | undefined][]) {
  return pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}="${esc(v!)}"`).join(" ")
}

function outlineFor(s: StoredUserSource, rsshubBase: string): string {
  const common: [string, string | undefined][] = [["text", s.name], ["title", s.name]]
  const ext: [string, string | undefined][] = [
    ["katana:slug", s.slug],
    ["katana:interval", String(s.interval)],
    ["katana:enabled", String(s.enabled)],
  ]
  const spec = s.spec
  let own: [string, string | undefined][]
  switch (spec.kind) {
    case "rss":
      own = [["type", "rss"], ["xmlUrl", spec.url]]
      break
    case "rsshub":
      own = [["type", "rss"], ["xmlUrl", new URL(spec.route, rsshubBase).toString()], ["katana:kind", "rsshub"], ["katana:spec", JSON.stringify(spec)]]
      break
    default:
      own = [["type", "link"], ["url", spec.url], ["katana:kind", spec.kind], ["katana:spec", JSON.stringify(spec)]]
  }
  return `<outline ${attrs([...common, ...own, ...ext])}/>`
}

export function exportOpml(sources: StoredUserSource[], rsshubBase: string, now: Date): string {
  const byCategory = new Map<string, StoredUserSource[]>()
  for (const s of sources) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s])
  const lines: string[] = []
  for (const s of byCategory.get("") ?? []) lines.push(`    ${outlineFor(s, rsshubBase)}`)
  for (const [category, list] of byCategory) {
    if (!category) continue
    lines.push(`    <outline ${attrs([["text", category], ["title", category]])}>`)
    for (const s of list) lines.push(`      ${outlineFor(s, rsshubBase)}`)
    lines.push("    </outline>")
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0" xmlns:katana="${OPML_NS}">
  <head>
    <title>newsnow user sources</title>
    <dateCreated>${now.toUTCString()}</dateCreated>
  </head>
  <body>
${lines.join("\n")}
  </body>
</opml>
`
}

/** 导入时从一个 outline 里读出的东西（还没校验） */
export interface OpmlEntry {
  name: string
  category: string
  slug?: string
  interval?: number
  enabled?: boolean
  spec?: unknown
  /** 读不出配置时的原因 */
  error?: string
}

type Node = Record<string, any>

function get(n: Node, key: string): string | undefined {
  const v = n[`@_${key}`]
  return v === undefined || v === null ? undefined : String(v)
}

export function parseOpml(xml: string): OpmlEntry[] {
  if (Buffer.byteLength(xml) > MAX_OPML_BYTES) throw new InputError(`OPML 超过 ${MAX_OPML_BYTES} 字节`, 413)
  let doc: Node
  try {
    doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseAttributeValue: false,
      isArray: name => name === "outline",
      // 不展开自定义实体（防实体膨胀）；&amp; 等预定义实体照常处理
      processEntities: { enabled: true, maxTotalExpansions: 1000 },
    }).parse(xml)
  } catch (e) {
    throw new InputError(`OPML 解析失败：${(e as Error).message}`)
  }
  const roots: Node[] = doc?.opml?.body?.outline
  if (!doc?.opml || !Array.isArray(roots)) throw new InputError("不是有效的 OPML：缺少 <opml><body><outline>")
  const out: OpmlEntry[] = []
  const walk = (nodes: Node[], folder: string) => {
    for (const n of nodes) {
      const text = get(n, "text") ?? get(n, "title") ?? ""
      const children: Node[] | undefined = n.outline
      const spec = get(n, "katana:spec")
      const xmlUrl = get(n, "xmlUrl")
      const isFeed = spec !== undefined || xmlUrl !== undefined || get(n, "katana:kind") !== undefined
      if (!isFeed) {
        // 文件夹：里面的订阅取它的名字当分类（嵌套时取最内层）
        if (children) walk(children, text || folder)
        continue
      }
      const entry: OpmlEntry = { name: text || xmlUrl || "", category: folder }
      const slug = get(n, "katana:slug")
      if (slug !== undefined) entry.slug = slug
      const interval = get(n, "katana:interval")
      if (interval !== undefined) entry.interval = Number(interval)
      const enabled = get(n, "katana:enabled")
      if (enabled !== undefined) entry.enabled = enabled === "true"
      if (spec !== undefined) {
        try {
          entry.spec = JSON.parse(spec)
        } catch {
          entry.error = "katana:spec 不是合法的 JSON"
        }
      } else if (xmlUrl !== undefined) {
        entry.spec = { kind: "rss", url: xmlUrl }
      }
      out.push(entry)
    }
  }
  walk(roots, "")
  return out
}
