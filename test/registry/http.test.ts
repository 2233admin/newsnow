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

  it("环境变量 USER_SOURCES_ALLOW_REMOTE=true 才放开对端、Host、Origin 检查", () => {
    expect(status(req({ remoteAddress: "8.8.8.8", headers: { host: "x.example", origin: "https://x.example" } }), { USER_SOURCES_ALLOW_REMOTE: "true" })).toBeUndefined()
    expect(status(req({ remoteAddress: "8.8.8.8" }), { USER_SOURCES_ALLOW_REMOTE: "1" })).toBe(403)
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
