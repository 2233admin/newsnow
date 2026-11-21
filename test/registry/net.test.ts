import { describe, expect, it, vi } from "vitest"
import { policy } from "./helpers"
import { assertAddressShape, assertFetchable, decodeBody, isBlockedAddress, safeFetchText } from "#/registry/net"
import { InputError } from "#/registry/spec"

const publicResolver = async () => ["93.184.216.34"]
const ok = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init })

describe("isBlockedAddress", () => {
  it("回环、内网、链路本地、CGNAT、保留、组播、IPv6 本地与 IPv4 映射都拒绝", () => {
    for (const ip of ["127.0.0.1", "127.8.8.8", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "not-an-ip"])
      expect(isBlockedAddress(ip), ip).toBe(true)
  })

  it("公网地址放行（含边界外的 172.32 与 100.128）", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.255.255", "100.128.0.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8"])
      expect(isBlockedAddress(ip), ip).toBe(false)
  })
})

describe("assertFetchable", () => {
  it("域名解析到内网的拒绝；任一解析结果在内网就拒绝", async () => {
    await expect(assertFetchable("http://internal.example/", policy(), async () => ["10.0.0.5"])).rejects.toThrow(/内网/)
    await expect(assertFetchable("http://mixed.example/", policy(), async () => ["93.184.216.34", "127.0.0.1"])).rejects.toThrow(/内网/)
    await assertFetchable("http://ok.example/", policy(), publicResolver)
  })

  it("iP 字面量（含十进制、十六进制写法、IPv6）按实际地址判断", async () => {
    for (const u of ["http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://[::ffff:7f00:1]/"])
      await expect(assertFetchable(u, policy(), publicResolver), u).rejects.toThrow(/内网/)
  })

  it("非 http(s)、带账号密码、解析失败都拒绝；allowPrivate 放行内网", async () => {
    await expect(assertFetchable("file:///etc/passwd", policy(), publicResolver)).rejects.toThrow(InputError)
    await expect(assertFetchable("http://u:p@a.example/", policy(), publicResolver)).rejects.toThrow(InputError)
    await expect(assertFetchable("http://nx.example/", policy(), async () => {
      throw new Error("ENOTFOUND")
    })).rejects.toThrow(/无法解析/)
    await assertFetchable("http://127.0.0.1:8080/", policy({ allowPrivate: true }), publicResolver)
  })

  it("保存时的静态检查：内网 IP 字面量与 localhost 拒绝，普通域名不查 DNS", () => {
    expect(() => assertAddressShape("http://127.0.0.1/x", policy())).toThrow(/内网/)
    expect(() => assertAddressShape("http://localhost:3000/x", policy())).toThrow(/内网/)
    expect(() => assertAddressShape("http://a.localhost/x", policy())).toThrow(/内网/)
    expect(() => assertAddressShape("https://example.com/x", policy())).not.toThrow()
    expect(() => assertAddressShape("http://localhost/x", policy({ allowPrivate: true }))).not.toThrow()
  })
})

describe("safeFetchText", () => {
  it("正常抓取，读出文本；按响应头声明的 gbk 解码", async () => {
    const fetchImpl = vi.fn(async () => ok("hello")) as unknown as typeof fetch
    expect(await safeFetchText("https://a.example/x", policy(), { fetchImpl, resolver: publicResolver })).toBe("hello")
    expect(decodeBody(new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4]), "text/xml; charset=gbk")).toBe("中文")
    expect(decodeBody(new TextEncoder().encode("<?xml version=\"1.0\" encoding=\"UTF-8\"?>中"), null)).toContain("中")
  })

  it("重定向逐跳校验：跳到内网的拒绝，请求不会发出", async () => {
    const fetchImpl = vi.fn(async (url: URL | string) => String(url).startsWith("https://a.example")
      ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
      : ok("secret")) as unknown as typeof fetch
    await expect(safeFetchText("https://a.example/x", policy(), { fetchImpl, resolver: publicResolver })).rejects.toThrow(/内网/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("重定向跳数有上限；相对地址的重定向可跟随", async () => {
    let n = 0
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: `/r${++n}` } })) as unknown as typeof fetch
    await expect(safeFetchText("https://a.example/x", policy(), { fetchImpl: loop, resolver: publicResolver })).rejects.toThrow(/重定向超过 3 跳/)
    expect(loop).toHaveBeenCalledTimes(4)
    const once = vi.fn(async (url: URL | string) => String(url).endsWith("/final") ? ok("done") : new Response(null, { status: 301, headers: { location: "/final" } })) as unknown as typeof fetch
    expect(await safeFetchText("https://a.example/x", policy(), { fetchImpl: once, resolver: publicResolver })).toBe("done")
  })

  it("响应体超过上限拒绝：声明的长度与实际流式读到的都查", async () => {
    const declared = vi.fn(async () => ok("x", { headers: { "content-length": "999999" } })) as unknown as typeof fetch
    await expect(safeFetchText("https://a.example/", policy({ maxBytes: 1000 }), { fetchImpl: declared, resolver: publicResolver })).rejects.toThrow(/超过上限/)
    const streamed = vi.fn(async () => ok("y".repeat(5000))) as unknown as typeof fetch
    await expect(safeFetchText("https://a.example/", policy({ maxBytes: 1000 }), { fetchImpl: streamed, resolver: publicResolver })).rejects.toThrow(/超过上限/)
  })

  it("超时：上游一直不回，到时中断", async () => {
    const hang = vi.fn((_: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })) as unknown as typeof fetch
    await expect(safeFetchText("https://a.example/", policy({ timeoutMs: 50 }), { fetchImpl: hang, resolver: publicResolver })).rejects.toThrow(/抓取超时/)
  })

  it("上游非 2xx 报错，错误信息里没有响应体", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>secret</html>", { status: 503 })) as unknown as typeof fetch
    await expect(safeFetchText("https://a.example/", policy(), { fetchImpl, resolver: publicResolver })).rejects.toThrow(/HTTP 503/)
  })
})
