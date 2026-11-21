import process from "node:process"
import type { H3Event } from "h3"
import { InputError } from "./spec"

/**
 * 用户源接口只给本机用（#2185）。判据：
 * - TCP 对端是回环地址（127.0.0.0/8、::1、::ffff:127.x）；
 * - 请求没有带转发头（X-Forwarded-For / Forwarded / X-Real-IP）：同机的反向代理转给我们时对端也是回环，
 *   但会带转发头，这种请求实际来自外面，拒绝。
 * 取不到对端地址（非 Node 运行时，如 Cloudflare）一律拒绝。
 * USER_SOURCES_ALLOW_REMOTE=true 关闭这道检查：只在你自己在前面加了认证时才用。
 *
 * 为什么不复用 auth.ts 的 JWT：#2183 定了用户订阅源存在工作台本地、不用 newsnow 的 GitHub 登录；
 * auth.ts 对 /api/collector 的处理只是「未配登录时放行」（与 health 相同），并没有鉴权。
 */
export function isLocalRequest(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>, env: Record<string, string | undefined> = process.env): boolean {
  if (env.USER_SOURCES_ALLOW_REMOTE === "true") return true
  if (!remoteAddress) return false
  if (["x-forwarded-for", "forwarded", "x-real-ip"].some(h => headers[h] !== undefined)) return false
  return remoteAddress === "::1" || /^127\./.test(remoteAddress) || /^::ffff:127\./i.test(remoteAddress)
}

export function requireLocal(event: H3Event) {
  if (!isLocalRequest(event.node.req.socket?.remoteAddress, event.node.req.headers))
    throw createError({ statusCode: 403, message: "用户源接口只允许本机访问" })
}

/** 业务错误（InputError）翻译成对应的 HTTP 状态；其余原样抛给 Nitro 记 500。 */
export async function guarded<T>(event: H3Event, fn: () => Promise<T>): Promise<T> {
  requireLocal(event)
  try {
    return await fn()
  } catch (e) {
    if (e instanceof InputError) throw createError({ statusCode: e.status, message: e.message })
    logger.error(e)
    throw e
  }
}
