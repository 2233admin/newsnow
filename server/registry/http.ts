import process from "node:process"
import { createHash, timingSafeEqual } from "node:crypto"
import type { H3Event } from "h3"
import { InputError } from "./spec"

/**
 * 用户源接口只给本机用（#2185）。浏览器里任何网页都能向 http://127.0.0.1:<端口> 发请求，TCP 对端是回环并不能说明
 * 请求是本机用户自己发的，所以除了对端地址，还要挡「网页替用户发」的两种路径（做法与 Vite dev server、Jupyter 一致）：
 *
 * 1. 对端是回环（127.0.0.0/8、::1、::ffff:127.x），且没有转发头（X-Forwarded-For / Forwarded / X-Real-IP）：
 *    同机反向代理转来的请求对端也是回环，但带转发头，实际来自外面。取不到对端地址一律拒绝。
 * 2. 防 DNS 重绑定：Host 必须是 localhost / 127.0.0.1 / [::1]（端口任意）。重绑定到 127.0.0.1 的攻击者域名
 *    对浏览器算同源，但它发出的 Host 是攻击者的域名。
 * 3. 防 CSRF：有 Origin 时它的主机也必须在上面的白名单里（端口任意：工作台与服务不同端口；Origin: null 拒绝）；
 *    Sec-Fetch-Site 为 cross-site 拒绝（same-origin / same-site / none 放行）。curl 与服务端调用不带这两个头，不受影响。
 * 4. 写接口的请求体只收 application/json：非 JSON 的 POST（text/plain、表单）是「简单请求」，浏览器不发预检，
 *    副作用照样发生；要求 JSON 让跨站请求必须先过预检，而本服务不回 CORS 头，预检必败。OPML 导入因此也是
 *    `{ "opml": "<xml…>" }` 的 JSON，不再收裸 XML。DELETE 没有请求体，不要求 Content-Type（它本来就要预检）。
 *
 * 为什么不复用 auth.ts 的 JWT：#2183 定了用户订阅源存在工作台本地、不用 newsnow 的 GitHub 登录；
 * auth.ts 对 /api/collector 的处理只是「未配登录时放行」（与 health 相同），并没有鉴权。
 *
 * 非本机访问（docker 里宿主机访问容器时对端是网桥地址，如 172.17.0.1，不是回环）只有一条路：设置
 * USER_SOURCES_TOKEN=<随机串>，请求带 `Authorization: Bearer <令牌>`（常量时间比较）。令牌通过后不再查对端、Host、转发头
 * （这些请求本来就不是本机的）；第 4 项照常生效。没设令牌就只给本机。令牌是唯一的凭据：泄露等于对所有能连上端口的人开放，
 * 请用 32 位以上的随机串，并只在受信任的网络里暴露端口。
 */
export interface AccessRequest {
  remoteAddress: string | undefined
  method: string
  headers: Record<string, string | string[] | undefined>
}

export interface AccessDenied {
  status: number
  message: string
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

function headerOf(headers: AccessRequest["headers"], name: string): string | undefined {
  const v = headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** `host:port` / `[::1]:port` / `host` → 小写主机名（IPv6 保留方括号）。解析不了返回 undefined。 */
function hostnameOf(hostHeader: string): string | undefined {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function isLoopback(address: string) {
  return address === "::1" || /^127\./.test(address) || /^::ffff:127\./i.test(address)
}

/** 先各取 SHA-256 再 timingSafeEqual：长度不同也不会提前返回，不泄露令牌长度。 */
function tokenMatches(authorization: string | undefined, token: string) {
  const presented = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1]
  if (!presented) return false
  return timingSafeEqual(createHash("sha256").update(presented).digest(), createHash("sha256").update(token).digest())
}

/** 通过返回 undefined，否则返回该给的状态码与原因。 */
export function checkAccess(req: AccessRequest, env: Record<string, string | undefined> = process.env): AccessDenied | undefined {
  const { headers } = req
  const token = env.USER_SOURCES_TOKEN
  if (!(token && tokenMatches(headerOf(headers, "authorization"), token))) {
    if (!req.remoteAddress || !isLoopback(req.remoteAddress) || ["x-forwarded-for", "forwarded", "x-real-ip"].some(h => headers[h] !== undefined))
      return { status: 403, message: "用户源接口只允许本机访问" }
    const host = headerOf(headers, "host")
    const hostname = host === undefined ? undefined : hostnameOf(host)
    if (!hostname || !LOCAL_HOSTS.has(hostname)) return { status: 403, message: "Host 必须是 localhost、127.0.0.1 或 [::1]" }
    const origin = headerOf(headers, "origin")
    if (origin !== undefined) {
      const originHost = origin === "null" ? undefined : hostnameOf(origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""))
      if (!originHost || !/^https?:\/\//i.test(origin) || !LOCAL_HOSTS.has(originHost)) return { status: 403, message: "不接受跨站请求（Origin）" }
    }
    if (headerOf(headers, "sec-fetch-site") === "cross-site") return { status: 403, message: "不接受跨站请求（Sec-Fetch-Site）" }
  }
  if (["POST", "PUT", "PATCH"].includes(req.method.toUpperCase())) {
    const type = headerOf(headers, "content-type")?.split(";")[0].trim().toLowerCase()
    if (type !== "application/json") return { status: 415, message: "写接口只接受 Content-Type: application/json" }
  }
}

export function requireLocal(event: H3Event) {
  const denied = checkAccess({ remoteAddress: event.node.req.socket?.remoteAddress, method: event.method, headers: event.node.req.headers })
  if (denied) throw createError({ statusCode: denied.status, message: denied.message })
}

/** 业务错误（InputError）翻译成对应的 HTTP 状态；其余原样抛给 Nitro 记 500。 */
export async function guarded<T>(event: H3Event, fn: () => Promise<T>): Promise<T> {
  requireLocal(event)
  try {
    return await fn()
  } catch (e) {
    if (e instanceof InputError) {
      if (e.retryAfterSec !== undefined) setResponseHeader(event, "Retry-After", e.retryAfterSec)
      throw createError({ statusCode: e.status, message: e.message })
    }
    logger.error(e)
    throw e
  }
}
