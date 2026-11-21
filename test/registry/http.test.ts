import { describe, expect, it } from "vitest"
import { isLocalRequest } from "#/registry/http"

describe("isLocalRequest（接口只给本机用）", () => {
  it("回环地址放行", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLocalRequest(ip, {}, {}), ip).toBe(true)
  })

  it("非回环、取不到对端地址的拒绝", () => {
    for (const ip of ["192.168.1.5", "10.0.0.1", "8.8.8.8", "::ffff:10.0.0.1", "fe80::1", undefined]) expect(isLocalRequest(ip, {}, {}), String(ip)).toBe(false)
  })

  it("同机反向代理转来的（带转发头）拒绝，哪怕对端是回环", () => {
    for (const h of ["x-forwarded-for", "forwarded", "x-real-ip"]) expect(isLocalRequest("127.0.0.1", { [h]: "1.2.3.4" }, {}), h).toBe(false)
  })

  it("环境变量 USER_SOURCES_ALLOW_REMOTE=true 才放开", () => {
    expect(isLocalRequest("8.8.8.8", {}, { USER_SOURCES_ALLOW_REMOTE: "true" })).toBe(true)
    expect(isLocalRequest("8.8.8.8", {}, { USER_SOURCES_ALLOW_REMOTE: "1" })).toBe(false)
  })
})
