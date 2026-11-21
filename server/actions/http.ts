import { getHeader } from "h3"
import type { H3Event } from "h3"
import type { Caller } from "./actions"

/** HTTP 入口的调用方：入口固定是 http，名字取自请求头 X-Actor（可空，自报，只用于审计里区分是谁）。 */
export function callerOf(event: H3Event): Caller {
  return { entry: "http", actor: getHeader(event, "x-actor") }
}
