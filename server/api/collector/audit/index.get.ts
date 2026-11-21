import { getActions } from "#/actions/runtime"
import { guarded } from "#/registry/http"
import { InputError } from "#/registry/spec"

/**
 * 审计记录，最新的在前：?limit=（1–200，默认 50）&before=<上一页最后一条的 id>。
 * 每条有 entry（http / mcp）、actor、action、summary、changes（每个源改动前后的配置）、undoOf、undoneBy。只给本机。
 */
export default defineEventHandler(event => guarded(event, async () => {
  const { limit, before } = getQuery(event)
  const num = (v: unknown, label: string) => {
    if (v === undefined || v === "") return undefined
    if (typeof v !== "string" || !/^\d+$/.test(v)) throw new InputError(`${label} 必须是整数`)
    return Number(v)
  }
  return { records: await (await getActions()).listAudit(num(limit, "limit") ?? 50, num(before, "before")) }
}))
