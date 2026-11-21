import type { StoredUserSource } from "./store"
import { exportOpml } from "./opml"
import {
  InputError,
  assertSlug,
  normalizeCategory,
  normalizeInterval,
  normalizeName,
  normalizeSpec,
} from "./spec"
import type { UserSourceConfig } from "./spec"
import pack from "./presets/feeds.json"

/**
 * 预置订阅包（#2187 第 3 项）：随仓库发的一份数据（presets/feeds.json），每个源一行配置。
 *
 * 做法（选的是「列表来自文件，启用时才进库」，不是「先全部导入成停用」）：
 * - 预置包本身不进库：库里的 user_sources 只有用户真正启用过的行，不占 MAX_USER_SOURCES 的名额，
 *   也不会让用户的订阅列表一上来就多出十几条停用的源。
 * - 启用 = 用预置包里的配置调用现有的 service.create（slug 就是预置的 slug，`preset-` 开头，避开用户自己起的名字），
 *   从这一刻起它就是普通用户源（id `user:preset-*`）：走注册表、采集、健康记录、OPML 导出、巡检，没有任何特殊路径。
 * - 停用 = 把那一行 enabled 置 false，行与历史保留；之后再启用沿用用户改过的间隔等设置，不被预置值覆盖。
 *   用户删掉那一行，预置就回到「未启用」。
 * - 另有 OPML 版本（presetsToOpml）：同一份数据用模块 2 的 exportOpml 序列化，katana:enabled="false"，
 *   所以经 `POST /api/collector/sources/opml` 导入后得到的行与上面的「启用」前状态完全一致（slug 相同、全部停用），
 *   也能直接导入别的阅读器（rule 类的 arXiv 在别的阅读器里只是普通链接，见 presets/feeds.json 里的 note）。
 */

/** official：站点官方的 RSS / Atom / API；google-news：官方已停，用 Google News 的 site: 搜索 RSS 代替；rsshub：RSSHub 路由 */
export type PresetChannel = "official" | "google-news" | "rsshub"
const CHANNELS: PresetChannel[] = ["official", "google-news", "rsshub"]

export interface PresetOrigin {
  channel: PresetChannel
  /** 出处：这个地址是从哪里来的（通常就是实测的地址本身，或文档页） */
  source: string
  /** 读取 / 核对日期 YYYY-MM-DD */
  readAt: string
  note?: string
}

export interface PresetSource extends UserSourceConfig {
  origin: PresetOrigin
}

export interface PresetPack {
  version: number
  description: string
  sources: PresetSource[]
}

/** 预置的 slug 一律 `preset-` 开头：与用户手建的源不撞名，也让 id 一眼能看出来历。 */
export const PRESET_SLUG_PREFIX = "preset-"

/** 校验并规范化整份预置包；任何一项不合 module 2 的规则都抛错（预置包坏了要在测试里红，不是运行时才发现）。 */
export function parsePack(raw: unknown, rsshubBase: string): PresetPack {
  const p = raw as { version?: unknown, description?: unknown, sources?: unknown }
  if (!p || p.version !== 1 || typeof p.description !== "string" || !Array.isArray(p.sources)) throw new InputError("预置包格式不对：需要 { version: 1, description, sources[] }")
  const seen = new Set<string>()
  const sources = p.sources.map((entry, i): PresetSource => {
    const e = entry as Record<string, any>
    const where = `预置包第 ${i + 1} 项`
    try {
      const slug = assertSlug(e.slug)
      if (!slug.startsWith(PRESET_SLUG_PREFIX)) throw new InputError(`slug 必须以 ${PRESET_SLUG_PREFIX} 开头`)
      if (seen.has(slug)) throw new InputError(`slug ${slug} 重复`)
      seen.add(slug)
      const o = e.origin
      if (!o || !CHANNELS.includes(o.channel) || typeof o.source !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.readAt ?? "")) throw new InputError("origin 需要 channel、source、readAt（YYYY-MM-DD）")
      if (e.interval === undefined) throw new InputError("interval 不能省略（预置包里每个源都写明间隔）")
      return {
        slug,
        name: normalizeName(e.name),
        category: normalizeCategory(e.category),
        interval: normalizeInterval(e.interval),
        enabled: false,
        spec: normalizeSpec(e.spec, rsshubBase),
        origin: { channel: o.channel, source: o.source, readAt: o.readAt, ...(typeof o.note === "string" && o.note ? { note: o.note } : {}) },
      }
    } catch (err) {
      if (err instanceof InputError) throw new InputError(`${where}（${e?.slug ?? "?"}）：${err.message}`)
      throw err
    }
  })
  return { version: 1, description: p.description, sources }
}

export function loadPack(rsshubBase: string): PresetPack {
  return parsePack(pack, rsshubBase)
}

/** 预置包的 OPML 版本：全部 katana:enabled="false"，导入后默认停用。 */
export function presetsToOpml(sources: PresetSource[], rsshubBase: string, now: Date): string {
  const rows: StoredUserSource[] = sources.map(s => ({ ...s, enabled: false, createdAt: 0, updatedAt: 0 }))
  return exportOpml(rows, rsshubBase, now)
}
