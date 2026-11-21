import { Buffer } from "node:buffer"
import { BlockList, isIP } from "node:net"
import { lookup } from "node:dns/promises"
import iconv from "iconv-lite"
import { InputError } from "./spec"

/**
 * 用户给的地址会被服务端抓取，所以出网前要防 SSRF（#2185）：
 * - 只许 http / https（spec.ts 的 checkHttpUrl 已查，这里再查一遍，重定向也走这里）。
 * - 域名先解析，解析出的每个地址都不能落在回环、内网、链路本地、CGNAT、保留与组播段；
 *   默认拒绝，`USER_SOURCES_ALLOW_PRIVATE=true` 才放行（给自建 RSSHub、内网 JSON 服务用）。
 * - 重定向逐跳手动跟随，最多 MAX_REDIRECTS 跳，每一跳重新校验。
 * - 总超时与响应体大小上限。
 *
 * 已知没防的：DNS 重绑定（校验时解析与实际连接时解析之间域名改指内网）。fetch 走进程级的代理设置，
 * 不能把连接钉在校验过的 IP 上；本模块的接口只给本机用，此风险写进 PR 说明。
 */

/**
 * 不可达的地址段。IPv4 部分取自 IANA 特殊用途地址表
 * （https://www.iana.org/assignments/iana-ipv4-special-registry/ ，读取日期 2026-11-21），
 * IPv6 同理（iana-ipv6-special-registry）。
 */
const BLOCKED = new BlockList()
for (const [net, prefix] of [
  ["0.0.0.0", 8], // 本网络
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // 链路本地，含云厂商的元数据地址 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // 组播
  ["240.0.0.0", 4], // 保留，含广播
] as const) BLOCKED.addSubnet(net, prefix, "ipv4")
for (const [net, prefix] of [
  ["::", 128], // 未指定
  ["::1", 128], // 回环
  ["64:ff9b::", 96], // NAT64：内嵌的 IPv4 可能是内网，整段拒绝
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // ULA
  ["fe80::", 10], // 链路本地
  ["ff00::", 8], // 组播
] as const) BLOCKED.addSubnet(net, prefix, "ipv6")

/** ::ffff:a.b.c.d（IPv4 映射）由 BlockList 按内嵌的 IPv4 判断（Node 文档的 blockList.check 示例）。 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (!family) return true // 认不出的一律当不安全
  return BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6")
}

export interface NetPolicy {
  allowPrivate: boolean
  /** 单次抓取（含重定向与读响应体）的总超时 */
  timeoutMs: number
  maxBytes: number
  maxRedirects: number
}

/**
 * 默认值的依据：
 * - timeoutMs 10 秒：与 server/utils/fetch.ts 里 myFetch 的单次请求超时一致（上游 newsnow 的取值）。
 * - maxBytes 5 MiB：实测（2026-11-21，沙箱）几个常见源的响应体 —— 见 PR 说明里的表；
 *   全文输出的 RSS 一般在几百 KB，超过 5 MiB 基本是错的地址（下载文件、视频）。待定，可用 USER_SOURCES_MAX_BYTES 调。
 * - maxRedirects 3：浏览器是 20，但订阅地址常见的 http→https、www 跳转最多两三跳。
 */
export const NET_DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 3,
} as const

export function readNetPolicy(env: Record<string, string | undefined>): NetPolicy {
  const maxBytes = Number(env.USER_SOURCES_MAX_BYTES)
  return {
    allowPrivate: env.USER_SOURCES_ALLOW_PRIVATE === "true",
    timeoutMs: NET_DEFAULTS.timeoutMs,
    maxBytes: Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : NET_DEFAULTS.maxBytes,
    maxRedirects: NET_DEFAULTS.maxRedirects,
  }
}

export type Resolver = (hostname: string) => Promise<string[]>
const defaultResolver: Resolver = async hostname => (await lookup(hostname, { all: true })).map(a => a.address)

/** 校验一个 URL 能不能出网；不能就抛 InputError。resolver 可注入，测试里不连 DNS。 */
export async function assertFetchable(raw: string | URL, policy: Pick<NetPolicy, "allowPrivate">, resolver: Resolver = defaultResolver) {
  const url = typeof raw === "string" ? new URL(raw) : raw
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new InputError("只支持 http 或 https 地址")
  if (url.username || url.password) throw new InputError("地址不能带账号密码")
  if (policy.allowPrivate) return
  const host = url.hostname.replace(/^\[|\]$/g, "")
  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = await resolver(host)
    } catch {
      throw new InputError(`无法解析域名 ${host}`, 502)
    }
  }
  if (!addresses.length || addresses.some(isBlockedAddress))
    throw new InputError(`${host} 指向内网或保留地址，已拒绝（自建服务可设 USER_SOURCES_ALLOW_PRIVATE=true）`, 403)
}

/**
 * 保存配置时的静态检查，不解析 DNS：地址是被拒绝段里的 IP 字面量，或 localhost / *.localhost。
 * 不在保存时解析域名，是因为 OPML 导入一次可能几十个地址，死链不该拖垮整批；
 * 域名真正指向哪里由每次抓取前的 assertFetchable 判断。
 */
export function assertAddressShape(raw: string, policy: Pick<NetPolicy, "allowPrivate">) {
  if (policy.allowPrivate) return
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if ((isIP(host) && isBlockedAddress(host)) || host === "localhost" || host.endsWith(".localhost"))
    throw new InputError(`${host} 指向内网或保留地址，已拒绝（自建服务可设 USER_SOURCES_ALLOW_PRIVATE=true）`, 403)
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new InputError(`响应体超过上限 ${maxBytes} 字节`, 413)
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new InputError(`响应体超过上限 ${maxBytes} 字节`, 413)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** 按 Content-Type、XML 声明、HTML meta 的顺序认编码，认不出按 UTF-8。 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1")
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1]
    ?? /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1]
    ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]
  const name = charset?.toLowerCase()
  if (name && !/^utf-?8$/.test(name) && iconv.encodingExists(name)) return iconv.decode(Buffer.from(bytes), name)
  return new TextDecoder("utf-8").decode(bytes)
}

export interface SafeFetchDeps {
  fetchImpl?: typeof fetch
  resolver?: Resolver
}

/** 带 SSRF 防护、超时、大小上限的文本抓取；所有用户源的出网都走这里。 */
export async function safeFetchText(rawUrl: string, policy: NetPolicy, deps: SafeFetchDeps = {}): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const signal = AbortSignal.timeout(policy.timeoutMs)
  let url = new URL(rawUrl)
  for (let hop = 0; ; hop++) {
    await assertFetchable(url, policy, deps.resolver)
    let res: Response
    try {
      res = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/json, text/xml, text/html;q=0.9, */*;q=0.5" },
      })
    } catch (e) {
      if (e instanceof InputError) throw e
      const timedOut = signal.aborted
      throw new InputError(timedOut ? `抓取超时（${policy.timeoutMs} 毫秒）` : `抓取失败：${(e as Error).message}`, 502)
    }
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      await res.body?.cancel().catch(() => {})
      if (hop >= policy.maxRedirects) throw new InputError(`重定向超过 ${policy.maxRedirects} 跳`, 502)
      url = new URL(res.headers.get("location")!, url)
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new InputError(`上游返回 HTTP ${res.status}`, 502)
    }
    try {
      return decodeBody(await readCapped(res, policy.maxBytes), res.headers.get("content-type"))
    } catch (e) {
      if (e instanceof InputError) throw e
      throw new InputError(signal.aborted ? `抓取超时（${policy.timeoutMs} 毫秒）` : `读取响应失败：${(e as Error).message}`, 502)
    }
  }
}
