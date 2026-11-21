import { InputError, toSourceId } from "./spec"
import type { UserSourceSpec } from "./spec"
import { presetsToOpml } from "./presets"
import type { PresetOrigin, PresetPack, PresetSource } from "./presets"
import type { SourceService, UserSourceView } from "./service"
import type { HealthRecord, ObservationStore } from "#/collector/store"
import { RSSHUB_BASE } from "#/utils/source"

/**
 * - available：库里没有这个源（没启用过，或启用后被用户删掉）
 * - enabled：在库里且启用，正在被采集
 * - disabled：在库里但停用（启用后又停用，历史与用户改过的设置都保留）
 */
export type PresetState = "available" | "enabled" | "disabled"

export interface PresetView {
  /** 完整的源 id（`user:preset-*`），启用后观测库与健康接口里用的就是它 */
  id: string
  slug: string
  name: string
  category: string
  interval: number
  spec: UserSourceSpec
  origin: PresetOrigin
  state: PresetState
  /** 库里的那一行与预置包不一样（用户改过名称、分类、间隔或地址）；启用 / 停用不会把它改回去 */
  modified: boolean
  health: HealthRecord | null
}

function sameConfig(p: PresetSource, row: UserSourceView) {
  return p.name === row.name && p.category === row.category && p.interval === row.interval && JSON.stringify(p.spec) === JSON.stringify(row.spec)
}

/**
 * 预置订阅包的服务层，只用 SourceService 的公开方法（list / create / update），不碰注册表的动作逻辑。
 */
export function createPresetService(deps: { service: SourceService, observations: Pick<ObservationStore, "deleteHealth">, pack: PresetPack, clock?: () => number }) {
  const { service, observations, pack } = deps
  const clock = deps.clock ?? Date.now

  const find = (slug: string) => {
    const preset = pack.sources.find(s => s.slug === slug)
    if (!preset) throw new InputError(`没有这个预置源：${slug}`, 404)
    return preset
  }

  const view = (p: PresetSource, row: UserSourceView | undefined): PresetView => ({
    id: toSourceId(p.slug),
    slug: p.slug,
    name: row?.name ?? p.name,
    category: row?.category ?? p.category,
    interval: row?.interval ?? p.interval,
    spec: row?.spec ?? p.spec,
    origin: p.origin,
    state: !row ? "available" : row.enabled ? "enabled" : "disabled",
    modified: row ? !sameConfig(p, row) : false,
    health: row?.health ?? null,
  })

  const rows = async () => new Map((await service.list()).map(r => [r.slug, r]))

  const presets = {
    async list(): Promise<PresetView[]> {
      const byslug = await rows()
      return pack.sources.map(p => view(p, byslug.get(p.slug)))
    },

    async get(slug: string): Promise<PresetView> {
      const p = find(slug)
      return view(p, (await rows()).get(p.slug))
    },

    /** 启用：库里没有就按预置包创建（enabled），有但停用就置为启用并清掉健康记录（下一轮重新开始计数），已启用则原样返回。 */
    async enable(slug: string): Promise<PresetView> {
      const p = find(slug)
      const row = (await rows()).get(p.slug)
      if (!row) {
        try {
          await service.create({ slug: p.slug, name: p.name, category: p.category, interval: p.interval, spec: p.spec, enabled: true })
        } catch (e) {
          // 并发的另一个请求刚创建了它：落到下面的更新；其余错误（名额满等）原样抛出
          if (!(e instanceof InputError && e.status === 409 && /已存在/.test(e.message))) throw e
          await service.update(p.slug, { enabled: true })
        }
      } else if (!row.enabled) {
        await service.update(p.slug, { enabled: true })
        // 停用前的连续失败数不能带进新一轮：否则重新启用后到第一次采集之前，巡检会按旧数据报它
        await observations.deleteHealth(toSourceId(p.slug))
      }
      return await presets.get(slug)
    },

    /** 停用：启用着的置为停用；本来就没启用的不动。 */
    async disable(slug: string): Promise<PresetView> {
      const p = find(slug)
      const row = (await rows()).get(p.slug)
      if (row?.enabled) await service.update(p.slug, { enabled: false })
      return await presets.get(slug)
    },

    /** 预置包的 OPML 版本（全部 katana:enabled="false"）。 */
    opml(): string {
      return presetsToOpml(pack.sources, RSSHUB_BASE, new Date(clock()))
    },
  }
  return presets
}

export type PresetService = ReturnType<typeof createPresetService>
