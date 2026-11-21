import type { FetchText } from "./adapters"
import { detect, runPreview } from "./detect"
import type { Preview } from "./detect"
import { assertAddressShape, assertFetchable } from "./net"
import type { NetPolicy, Resolver } from "./net"
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

export interface ServiceDeps {
  store: UserSourceStore
  observations: ObservationStore
  fetchText: FetchText
  policy: NetPolicy
  resolver?: Resolver
  clock?: () => number
}

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
  }
  return service
}

export type SourceService = ReturnType<typeof createSourceService>
