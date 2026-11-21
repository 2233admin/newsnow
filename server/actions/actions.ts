import type { AuditEntry, AuditRecord, AuditStore, SourceChange, SourceSnapshot } from "./audit"
import type { ImportResult, SourceService, UserSourceView } from "#/registry/service"
import { InputError, toSourceId } from "#/registry/spec"
import type { StoredUserSource, UserSourceStore } from "#/registry/store"
import type { Preview } from "#/registry/detect"

/**
 * 动作层（#2186）：用户订阅源的所有改动都从这里走，HTTP（/api/collector/…）与 MCP（/mcp）是同一套函数的两个入口，
 * 不各自实现一遍；业务规则与校验仍在 registry/service.ts，这里只负责「串行、记审计、撤销」。
 *
 * 审计怎么记：每个改动动作在串行锁里先读一遍全部用户源（至多 MAX_USER_SOURCES = 200 行）、执行、再读一遍，
 * 逐源比对得到 changes。这样导入（一次改很多个）、替换、服务层里的任何副作用都不会漏记，
 * 也不用让每个服务函数自己报「我改了什么」。动作没有改变任何东西（比如把已启用的源再启用）就不写审计，返回 auditId: null。
 * 校验不通过的请求抛错、不写审计。
 *
 * 为什么串行：审计的前后值是靠两次读库之差得到的，两个动作交错会把对方的改动算到自己头上；
 * 同时它也让「用户源 200 上限的计数与插入」在本进程内不再有竞态（#2264 第 5 项的一部分，跨进程仍要唯一约束，不在本票）。
 */

export interface Caller {
  entry: AuditEntry
  /** 调用方自报的名字（可空），只用于审计里区分是谁，不是身份认证 */
  actor?: string | null
}

export interface Done<T> {
  value: T
  /** 写了审计则是它的 id；动作没有改变任何东西时为 null */
  auditId: number | null
}

export interface ActionDeps {
  store: UserSourceStore
  service: SourceService
  audit: AuditStore
  clock?: () => number
}

const MAX_ACTOR = 64

/** 调用方名：去掉控制字符、折叠空白、限长；空则 null。 */
export function cleanActor(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ACTOR)
  return v || null
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function snapshot(s: StoredUserSource): SourceSnapshot {
  return { name: s.name, category: s.category, interval: s.interval, enabled: s.enabled, spec: s.spec }
}
const same = (a: SourceSnapshot | null, b: SourceSnapshot | null) => (a === null || b === null) ? a === b : stable(a) === stable(b)

export function diffSources(before: StoredUserSource[], after: StoredUserSource[]): SourceChange[] {
  const b = new Map(before.map(s => [s.slug, snapshot(s)]))
  const a = new Map(after.map(s => [s.slug, snapshot(s)]))
  const changes: SourceChange[] = []
  for (const slug of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const x = b.get(slug) ?? null
    const y = a.get(slug) ?? null
    if (!same(x, y)) changes.push({ slug, before: x, after: y })
  }
  return changes
}

const FIELD_LABEL = { name: "名称", category: "分类", interval: "间隔", enabled: "启停", spec: "配置" } as const

export function summarize(changes: SourceChange[]): string {
  const label = (c: SourceChange) => `${toSourceId(c.slug)}「${(c.after ?? c.before)!.name}」`
  if (changes.length === 1) {
    const [c] = changes
    if (!c.before) return `新增 ${label(c)}`
    if (!c.after) return `删除 ${label(c)}`
    const fields = (Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[]).filter(k => stable(c.before![k]) !== stable(c.after![k]))
    return `修改 ${label(c)}：${fields.map(k => FIELD_LABEL[k]).join("、")}`
  }
  const count = (f: (c: SourceChange) => boolean) => changes.filter(f).length
  return `新增 ${count(c => !c.before)}、修改 ${count(c => !!c.before && !!c.after)}、删除 ${count(c => !c.after)} 个用户源`
}

/** 撤销一条记录会把这些变化反过来做：顺序倒过来，before / after 对调。 */
const invert = (changes: SourceChange[]): SourceChange[] => [...changes].reverse().map(c => ({ slug: c.slug, before: c.after, after: c.before }))

export function createActions(deps: ActionDeps) {
  const { store, service, audit } = deps
  const clock = deps.clock ?? Date.now
  let chain: Promise<unknown> = Promise.resolve()
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }

  /** 串行执行 fn 并按前后差记审计；fn 中途抛错但已经改了一部分时，改了的那部分照样记上，再把错抛出去。 */
  function perform<T>(caller: Caller, action: string, fn: () => Promise<T>): Promise<Done<T>> {
    return locked(async () => {
      const before = await store.list()
      let value!: T
      let failure: unknown
      let failed = false
      try {
        value = await fn()
      } catch (e) {
        failed = true
        failure = e
      }
      const changes = diffSources(before, await store.list())
      const rec = changes.length
        ? await audit.append({ at: clock(), entry: caller.entry, actor: cleanActor(caller.actor), action, summary: summarize(changes), changes, undoOf: null })
        : null
      if (failed) throw failure
      return { value, auditId: rec?.id ?? null }
    })
  }

  const patchOne = (caller: Caller, action: string, slug: string, patch: Record<string, unknown>) =>
    perform(caller, action, () => service.update(slug, patch))

  /** 把一项变化顺着做一遍（状态 before → after），经服务层，校验与新增、修改、删除时一致。 */
  async function applyForward(c: SourceChange) {
    if (c.after === null) await service.remove(c.slug)
    else if (c.before === null) await service.create({ ...c.after, slug: c.slug })
    else await service.update(c.slug, c.after)
  }

  const actions = {
    // ---- 读（不记审计） ----
    list: (): Promise<UserSourceView[]> => service.list(),
    get: (slug: string): Promise<UserSourceView> => service.get(slug),
    preview: (body: unknown): Promise<Preview> => service.preview(body),
    exportOpml: (): Promise<string> => service.exportOpml(),

    async listAudit(limit = 50, before?: number): Promise<AuditRecord[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new InputError("limit 必须是 1 到 200 的整数")
      if (before !== undefined && (!Number.isInteger(before) || before < 1)) throw new InputError("before 必须是审计 id")
      return await audit.list(limit, before)
    },

    // ---- 改（记审计，可撤销） ----
    addSource: (caller: Caller, body: unknown) => perform(caller, "source.add", async () => await service.create(body)),
    removeSource: (caller: Caller, slug: string) => perform(caller, "source.remove", () => service.remove(slug)),
    /** 部分更新：name / category / interval / enabled / spec，给哪项改哪项 */
    updateSource: (caller: Caller, slug: string, patch: Record<string, unknown>) => patchOne(caller, "source.update", slug, patch),
    setEnabled: (caller: Caller, slug: string, enabled: unknown) => patchOne(caller, enabled === false ? "source.disable" : "source.enable", slug, { enabled }),
    setCategory: (caller: Caller, slug: string, category: unknown) => patchOne(caller, "source.set-category", slug, { category }),
    setInterval: (caller: Caller, slug: string, interval: unknown) => patchOne(caller, "source.set-interval", slug, { interval }),
    importOpml: (caller: Caller, xml: string, onConflict: "skip" | "replace" = "skip"): Promise<Done<ImportResult>> =>
      perform(caller, "source.import", () => service.importOpml(xml, onConflict)),

    /**
     * 按审计记录撤销。只有「现在的状态正好是这条记录改出来的状态」才撤销：之后又被改过的，
     * 直接拒绝（409）并说明，不覆盖后来的改动——先撤销后面的。整组变化先全部检查再动手。
     * 撤销也写一行审计；撤销一条撤销记录就是重做。
     */
    undo(caller: Caller, id: number): Promise<Done<AuditRecord>> {
      return locked(async () => {
        if (!Number.isInteger(id) || id < 1) throw new InputError("审计 id 无效")
        const rec = await audit.get(id)
        if (!rec) throw new InputError(`没有审计记录 #${id}`, 404)
        if (rec.undoneBy !== null) throw new InputError(`审计 #${id} 已被撤销（#${rec.undoneBy}）`, 409)
        const current = new Map((await store.list()).map(s => [s.slug, snapshot(s)]))
        for (const c of rec.changes) {
          if (!same(current.get(c.slug) ?? null, c.after)) {
            throw new InputError(`${toSourceId(c.slug)} 在审计 #${id} 之后又被改过，不能直接撤销；请先撤销后面的改动`, 409)
          }
        }
        const applied: SourceChange[] = []
        let failure: unknown
        let failed = false
        for (const c of invert(rec.changes)) {
          try {
            await applyForward(c)
            applied.push(c)
          } catch (e) {
            failed = true
            failure = e
            break
          }
        }
        if (!applied.length) throw failure
        const undo = await audit.append({
          at: clock(),
          entry: caller.entry,
          actor: cleanActor(caller.actor),
          action: "audit.undo",
          summary: `撤销 #${id}：${summarize(applied)}`,
          changes: applied,
          undoOf: id,
        })
        if (!failed) {
          await audit.setUndoneBy(id, undo.id)
          // 撤销的是一条撤销记录（重做）：被它撤销过的原记录重新生效
          if (rec.undoOf !== null) await audit.setUndoneBy(rec.undoOf, null)
        }
        if (failed) throw failure
        return { value: (await audit.get(undo.id))!, auditId: undo.id }
      })
    },
  }
  return actions
}

export type Actions = ReturnType<typeof createActions>
