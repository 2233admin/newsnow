import { callerOf } from "#/actions/http"
import { getActions } from "#/actions/runtime"
import { guarded } from "#/registry/http"
import { InputError } from "#/registry/spec"

/**
 * 撤销一条审计记录对应的改动。请求体用 `{}`（写接口只收 Content-Type: application/json，见 registry/http.ts）。
 * 撤销后现状与记录里的「改之后」不一致（之后又被改过）→ 409，先撤销后面的。撤销本身也写一条审计，返回它。
 */
export default defineEventHandler(event => guarded(event, async () => {
  const id = getRouterParam(event, "id") ?? ""
  if (!/^\d+$/.test(id)) throw new InputError("审计 id 无效")
  const { value } = await (await getActions()).undo(callerOf(event), Number(id))
  return value
}))
