import type { FetchText } from "./adapters"
import { detect, runPreview } from "./detect"
import type { Preview } from "./detect"
import { assertAddressShape, assertFetchable } from "./net"
import type { NetPolicy, Resolver } from "./net"
import { exportOpml, parseOpml } from "./opml"
import {
  InputError,
  MAX_USER_SOURCES,
  assertSlug,
  normalizeCategory,
  normalizeEnabled,
  normalizeInterval,
  normalizeName,
  normalizeSpec,
  slugify,
  specAddress,
  toSourceId,
} from "./spec"
import type { UserSourceConfig, UserSourceSpec } from "./spec"
import type { StoredUserSource, UserSourceStore } from "./store"
import { RSSHUB_BASE } from "#/utils/source"
import type { HealthRecord, ObservationStore } from "#/collector/store"

export interface UserSourceView extends StoredUserSource {
  /** 完整的源 id，观测库与健康接口里用的就是它 */
  id: string
  health: HealthRecord | null
}

export interface ImportResult {
  imported: string[]
  replaced: string[]
  skipped: { name: string, reason: string }[]
  failed: { name: string, error: string }[]
}

export interface ServiceDeps {
  store: UserSourceStore
  observations: ObservationStore
  fetchText: FetchText
  policy: NetPolicy
  resolver?: Resolver
  clock?: () => number
}

const addressOf = (spec: UserSourceSpec) => `${spec.kind === "rsshub" ? "rsshub" : "url"}:${specAddress(spec)}`

/**
 * 用户源的服务层：HTTP 处理函数只做「只给本机」的检查与错误翻译，业务都在这里，方便不起服务就测。
 */
export function createSourceService(deps: ServiceDeps) {
  const { store, observations, fetchText, policy } = deps
  const clock = deps.clock ?? Date.now

  const view = (s: StoredUserSource, health: Map<string, HealthRecord>): UserSourceView => ({
    ...s,
    id: toSourceId(s.slug),
    health: health.get(toSourceId(s.slug)) ?? null,
  })
  const healthMap = async () => new Map((await observations.getHealth()).map(h => [h.sourceId, h]))

  /** 校验规范化后的配置并做保存前的静态地址检查 */
  function checkSpec(raw: unknown): UserSourceSpec {
    const spec = normalizeSpec(raw, RSSHUB_BASE)
    if (spec.kind !== "rsshub") assertAddressShape(spec.url, policy)
    return spec
  }

  async function uniqueSlug(preferred: string | undefined, name: string, spec: UserSourceSpec, config: Omit<UserSourceConfig, "slug">): Promise<string> {
    const now = clock()
    if (preferred !== undefined) {
      const slug = assertSlug(preferred)
      if (!(await store.insert({ ...config, slug }, now))) throw new InputError(`${toSourceId(slug)} 已存在`, 409)
      return slug
    }
    let host = ""
    try {
      host = spec.kind === "rsshub" ? spec.route : new URL(spec.url).hostname
    } catch {}
    const base = slugify(name, host)
    for (let i = 1; i <= 50; i++) {
      const slug = i === 1 ? base : `${base.slice(0, 44)}-${i}`
      if (await store.insert({ ...config, slug }, now)) return slug
    }
    throw new InputError("生成不出不重复的 slug，请手动指定", 409)
  }

  async function assertRoom(extra = 1) {
    if ((await store.list()).length + extra > MAX_USER_SOURCES) throw new InputError(`用户源已达上限 ${MAX_USER_SOURCES}`, 409)
  }

  const service = {
    async list(): Promise<UserSourceView[]> {
      const health = await healthMap()
      return (await store.list()).map(s => view(s, health))
    },

    async get(slug: string): Promise<UserSourceView> {
      const s = await store.get(assertSlug(slug))
      if (!s) throw new InputError("没有这个用户源", 404)
      return view(s, await healthMap())
    },

    /**
     * 预览：body 要么是 { url }（自动识别类型，/路由 与 rsshub:// 也算），
     * 要么是 { spec }（给定配置，用来试手写的 JSON 映射与选择器规则）。抓 5 条，不保存。
     */
    async preview(body: any): Promise<Preview> {
      if (typeof body?.url === "string") {
        const raw = body.url.trim()
        if (/^https?:/i.test(raw)) {
          assertAddressShape(raw, policy)
          await assertFetchable(raw, policy, deps.resolver)
        }
        return await detect(raw, { fetchText, rsshubBase: RSSHUB_BASE })
      }
      if (body?.spec) {
        const spec = checkSpec(body.spec)
        return await runPreview(spec, fetchText, spec.kind === "rsshub" ? spec.route : new URL(spec.url).hostname)
      }
      throw new InputError("需要 url（自动识别）或 spec（指定配置）")
    },

    async create(body: any): Promise<UserSourceView> {
      const spec = checkSpec(body?.spec)
      const config = {
        name: normalizeName(body?.name),
        category: normalizeCategory(body?.category),
        interval: normalizeInterval(body?.interval),
        enabled: normalizeEnabled(body?.enabled),
        spec,
      }
      await assertRoom()
      const slug = await uniqueSlug(body?.slug, config.name, spec, config)
      return await service.get(slug)
    },

    /** 部分更新：给了哪项改哪项。改了 spec 就清掉健康记录，下一轮立即重新抓。 */
    async update(slug: string, body: any): Promise<UserSourceView> {
      const current = await store.get(assertSlug(slug))
      if (!current) throw new InputError("没有这个用户源", 404)
      const spec = body?.spec !== undefined ? checkSpec(body.spec) : current.spec
      const next: UserSourceConfig = {
        slug: current.slug,
        name: body?.name !== undefined ? normalizeName(body.name) : current.name,
        category: body?.category !== undefined ? normalizeCategory(body.category) : current.category,
        interval: body?.interval !== undefined ? normalizeInterval(body.interval) : current.interval,
        enabled: body?.enabled !== undefined ? normalizeEnabled(body.enabled) : current.enabled,
        spec,
      }
      await store.update(next, clock())
      if (JSON.stringify(spec) !== JSON.stringify(current.spec)) await observations.deleteHealth(toSourceId(slug))
      return await service.get(slug)
    },

    /** 删配置与健康记录；历史观测与条目保留（观测库是全量入库，不随订阅消失）。 */
    async remove(slug: string): Promise<void> {
      assertSlug(slug)
      if (!(await store.delete(slug))) throw new InputError("没有这个用户源", 404)
      await observations.deleteHealth(toSourceId(slug))
    },

    async exportOpml(): Promise<string> {
      return exportOpml(await store.list(), RSSHUB_BASE, new Date(clock()))
    },

    /**
     * 导入 OPML。带 katana:slug 的按 slug 对应：已存在时 skip（默认）保留现有，replace 用文件里的覆盖；
     * 没有 katana:slug 的（别的阅读器导出的）按地址去重，已有同地址的跳过，新的生成 slug。
     */
    async importOpml(xml: string, onConflict: "skip" | "replace" = "skip"): Promise<ImportResult> {
      const entries = parseOpml(xml)
      const result: ImportResult = { imported: [], replaced: [], skipped: [], failed: [] }
      const existing = await store.list()
      const addresses = new Set(existing.map(s => addressOf(s.spec)))
      const slugs = new Set(existing.map(s => s.slug))
      let count = existing.length
      for (const entry of entries) {
        const label = entry.name || entry.slug || "(无名)"
        try {
          if (entry.error) throw new InputError(entry.error)
          const spec = checkSpec(entry.spec)
          const config = {
            name: normalizeName(entry.name),
            category: normalizeCategory(entry.category),
            interval: normalizeInterval(entry.interval),
            enabled: normalizeEnabled(entry.enabled),
            spec,
          }
          if (entry.slug !== undefined && slugs.has(assertSlug(entry.slug))) {
            if (onConflict === "skip") {
              result.skipped.push({ name: label, reason: `${toSourceId(entry.slug)} 已存在` })
              continue
            }
            await store.update({ ...config, slug: entry.slug }, clock())
            await observations.deleteHealth(toSourceId(entry.slug))
            result.replaced.push(toSourceId(entry.slug))
            continue
          }
          if (entry.slug === undefined && addresses.has(addressOf(spec))) {
            result.skipped.push({ name: label, reason: "已有相同地址的源" })
            continue
          }
          if (count + 1 > MAX_USER_SOURCES) throw new InputError(`用户源已达上限 ${MAX_USER_SOURCES}`)
          const slug = await uniqueSlug(entry.slug, config.name, spec, config)
          slugs.add(slug)
          addresses.add(addressOf(spec))
          count++
          result.imported.push(toSourceId(slug))
        } catch (e) {
          result.failed.push({ name: label, error: e instanceof Error ? e.message : String(e) })
        }
      }
      return result
    },
  }
  return service
}

export type SourceService = ReturnType<typeof createSourceService>
