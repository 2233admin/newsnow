import { describe, expect, it } from "vitest"
import { checkAccess } from "#/registry/http"
import type { AccessRequest } from "#/registry/http"

function req(over: Partial<AccessRequest> & { headers?: AccessRequest["headers"] } = {}): AccessRequest {
  return {
    remoteAddress: "127.0.0.1",
    method: "GET",
    ...over,
    headers: { host: "127.0.0.1:3121", ...over.headers },
  }
}
const status = (r: AccessRequest, env: Record<string, string | undefined> = {}) => checkAccess(r, env)?.status

describe("checkAccess：对端地址（接口只给本机用）", () => {
  it("回环地址放行", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(status(req({ remoteAddress: ip })), ip).toBeUndefined()
  })

  it("非回环、取不到对端地址的拒绝", () => {
    for (const ip of ["192.168.1.5", "10.0.0.1", "8.8.8.8", "::ffff:10.0.0.1", "fe80::1", undefined]) expect(status(req({ remoteAddress: ip })), String(ip)).toBe(403)
  })

  it("同机反向代理转来的（带转发头）拒绝，哪怕对端是回环", () => {
    for (const h of ["x-forwarded-for", "forwarded", "x-real-ip"]) expect(status(req({ headers: { [h]: "1.2.3.4" } })), h).toBe(403)
  })

  it("没设令牌时，带任何 Authorization 的非本机请求也拒绝", () => {
    expect(status(req({ remoteAddress: "8.8.8.8", headers: { authorization: "Bearer anything" } }))).toBe(403)
    expect(status(req({ remoteAddress: "8.8.8.8", headers: { authorization: "Bearer " } }), { USER_SOURCES_TOKEN: "" })).toBe(403)
  })

  it("旧开关 USER_SOURCES_ALLOW_REMOTE 已移除，不再有任何作用", () => {
    expect(status(req({ remoteAddress: "8.8.8.8" }), { USER_SOURCES_ALLOW_REMOTE: "true" })).toBe(403)
  })
})

describe("checkAccess：USER_SOURCES_TOKEN（设了令牌才允许非本机访问）", () => {
  const env = { USER_SOURCES_TOKEN: "s3cret-token-0123456789" }
  const remote = (authorization?: string, extra: Record<string, string> = {}) =>
    req({ remoteAddress: "172.17.0.1", headers: { host: "news.internal:3121", ...(authorization ? { authorization } : {}), ...extra } })

  it("带正确的 Bearer 令牌放行（对端、Host、转发头都不再限制，反向代理 / docker 网桥可用）", () => {
    expect(status(remote("Bearer s3cret-token-0123456789"), env)).toBeUndefined()
    expect(status(remote("bearer s3cret-token-0123456789", { "x-forwarded-for": "1.2.3.4" }), env)).toBeUndefined()
  })

  it("缺令牌、令牌错、前缀长度不同、不是 Bearer 方案都拒绝", () => {
    for (const a of [undefined, "Bearer wrong", "Bearer s3cret-token-0123456780", "Bearer s3cret-token-01234567890", "Bearer s3cret", "Bearer ", "Basic czNjcmV0LXRva2VuLTAxMjM0NTY3ODk=", "s3cret-token-0123456789"])
      expect(status(remote(a), env), String(a)).toBe(403)
  })

  it("令牌通过也要遵守写接口只收 JSON", () => {
    expect(status({ ...remote("Bearer s3cret-token-0123456789"), method: "POST" }, env)).toBe(415)
    expect(status({ ...remote("Bearer s3cret-token-0123456789", { "content-type": "application/json" }), method: "POST" }, env)).toBeUndefined()
  })

  it("设了令牌不影响本机访问：本机仍无需令牌，Host / Origin 检查照旧", () => {
    expect(status(req(), env)).toBeUndefined()
    expect(status(req({ headers: { host: "attacker-rebind.example" } }), env)).toBe(403)
    expect(status(req({ headers: { origin: "https://evil.example" } }), env)).toBe(403)
  })
})

describe("checkAccess：Host 白名单（防 DNS 重绑定）", () => {
  it("localhost、127.0.0.1、[::1]，带不带端口都认，大小写不敏感", () => {
    for (const host of ["localhost", "localhost:3121", "127.0.0.1", "127.0.0.1:80", "[::1]", "[::1]:3121", "LocalHost:3121"])
      expect(status(req({ headers: { host } })), host).toBeUndefined()
  })

  it("其他 Host、缺 Host、畸形 Host 拒绝", () => {
    for (const host of ["attacker-rebind.example", "attacker-rebind.example:3121", "localhost.evil.example", "127.0.0.1.evil.example", "evil.example/127.0.0.1", "127.0.0.2", "", "[::2]"])
      expect(status(req({ headers: { host } })), host).toBe(403)
    expect(status({ remoteAddress: "127.0.0.1", method: "GET", headers: {} })).toBe(403)
  })
})

describe("checkAccess：Origin 与 Sec-Fetch-Site（防 CSRF）", () => {
  it("origin 在白名单（任意端口，工作台与服务不同端口）放行", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:3121", "http://[::1]:5173", "https://localhost"])
      expect(status(req({ headers: { origin } })), origin).toBeUndefined()
  })

  it("拒绝 Origin：别的站、null、畸形、非 http 的拒绝", () => {
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example", "http://127.0.0.1.evil.example:80", "file://", "chrome-extension://abc", "garbage"])
      expect(status(req({ headers: { origin } })), origin).toBe(403)
  })

  it("跨站：Sec-Fetch-Site 为 cross-site 拒绝；same-origin / same-site / none 与缺省放行", () => {
    expect(status(req({ headers: { "sec-fetch-site": "cross-site" } }))).toBe(403)
    for (const v of ["same-origin", "same-site", "none"]) expect(status(req({ headers: { "sec-fetch-site": v } })), v).toBeUndefined()
  })
})

describe("checkAccess：写接口只收 application/json", () => {
  const body = (method: string, type?: string) => req({ method, headers: type ? { "content-type": type } : {} })

  it("写方法 POST / PUT / PATCH 缺 Content-Type 或不是 JSON 返回 415", () => {
    for (const m of ["POST", "PUT", "PATCH"]) {
      for (const t of [undefined, "text/plain", "application/x-www-form-urlencoded", "text/xml", "multipart/form-data; boundary=x", "application/jsonx"])
        expect(status(body(m, t)), `${m} ${t}`).toBe(415)
      expect(status(body(m, "application/json")), m).toBeUndefined()
      expect(status(body(m, "Application/JSON; charset=utf-8")), m).toBeUndefined()
    }
  })

  it("读方法与没有请求体的 DELETE 不要求 Content-Type", () => {
    expect(status(body("GET"))).toBeUndefined()
    expect(status(body("DELETE"))).toBeUndefined()
  })

  it("跨站检查先于 Content-Type：跨站的 text/plain 是 403 而不是 415", () => {
    expect(status(req({ method: "POST", headers: { "content-type": "text/plain", "origin": "https://evil.example" } }))).toBe(403)
  })
})
