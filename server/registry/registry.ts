import type { Source } from "@shared/types"
import { buildGetter } from "./adapters"
import type { FetchText } from "./adapters"
import { isUserSourceId, toSourceId } from "./spec"
import type { UserSourceStore } from "./store"
import type { SourceGetters, SourceMetas } from "#/collector/collect"

/**
 * 运行时注册表（#2185）：内置源（代码，构建时打包）+ 用户源（库里的配置）合并成一份，
 * 采集器与健康接口每次都从这里取，所以加、改、停、删用户源不需要重新构建也不需要重启。
 *
 * - 用户源 id 一律是 `user:<slug>`，内置源 id 里没有冒号，上游同步新增内置源不会与用户源重名；
 *   内置源 id 若以 `user:` 开头（不应发生）直接报错，不静默覆盖。
 * - 停用的源不进快照，所以不再被采集；它的历史观测、条目留在库里，不受影响。
 * - 每次取快照读一次库（至多 MAX_USER_SOURCES 行），不缓存：采集每分钟一轮，读一次库的成本可以忽略，
 *   换来的是改完立即生效、也没有缓存失效要处理。
 */
export interface Registry {
  /** 当前要采集的源：内置 + 已启用的用户源 */
  snapshot: () => Promise<{ sources: SourceMetas, getters: SourceGetters }>
  /** 信息流用的源说明：id、显示名、分类、是否在采集；用户源含停用的（#2186） */
  describe: () => Promise<SourceDescriptor[]>
}

export interface SourceDescriptor {
  id: string
  name: string
  /** 内置源是 shared/sources.json 的 column（china、tech、finance…），没有的是空串；用户源是用户填的分类 */
  category: string
  builtin: boolean
  /** 内置源恒为 true；用户源是启停开关。停用与删除的源的历史条目默认不进信息流。 */
  enabled: boolean
}

export type BuiltinSourceMeta = Pick<Source, "interval" | "redirect"> & Partial<Pick<Source, "name" | "title" | "column">>

export interface RegistryDeps {
  builtinSources: Record<string, BuiltinSourceMeta>
  builtinGetters: SourceGetters
  store: UserSourceStore
  fetchText: FetchText
  log?: { warn: (...args: any[]) => void }
}

export function createRegistry(deps: RegistryDeps): Registry {
  const { builtinSources, builtinGetters, store, fetchText } = deps
  const log = deps.log ?? logger
  const clash = Object.keys(builtinSources).find(isUserSourceId)
  if (clash) throw new Error(`内置源 id ${clash} 占用了用户源的命名空间 user:`)

  return {
    async describe() {
      const out: SourceDescriptor[] = []
      for (const [id, meta] of Object.entries(builtinSources)) {
        // redirect 是别名，不采集，库里没有它的条目
        if (meta.redirect) continue
        out.push({ id, name: [meta.name ?? id, meta.title].filter(Boolean).join(" "), category: meta.column ?? "", builtin: true, enabled: true })
      }
      try {
        for (const user of await store.list()) out.push({ id: toSourceId(user.slug), name: user.name, category: user.category, builtin: false, enabled: user.enabled })
      } catch (e) {
        log.warn("read user sources failed, describing built-in sources only", e)
      }
      return out
    },

    async snapshot() {
      const sources: SourceMetas = { ...(builtinSources as SourceMetas) }
      const getters: SourceGetters = { ...builtinGetters }
      let users: Awaited<ReturnType<UserSourceStore["list"]>> = []
      try {
        users = await store.list()
      } catch (e) {
        // 读不到用户源配置（库暂时不可用）时内置源照常采集
        log.warn("read user sources failed, collecting built-in sources only", e)
      }
      for (const user of users) {
        if (!user.enabled) continue
        const id = toSourceId(user.slug)
        try {
          getters[id] = buildGetter(user.spec, fetchText)
          sources[id] = { interval: user.interval }
        } catch (e) {
          // 库里的配置坏了（手改库、版本升级后形状不兼容）：跳过这一个，其余照常采集
          log.warn(`skip user source ${id}`, e)
        }
      }
      return { sources, getters }
    },
  }
}
