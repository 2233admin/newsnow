/**
 * 链接归一（去重键之一，#2188）：同一篇文章被不同源、不同追踪参数带出来的链接，归一后相同。
 *
 * 规则：只认 http / https；主机名小写并去掉开头的 `www.`；去掉 fragment；去掉常见的追踪参数（utm_*、fbclid、gclid、spm、from 等）与
 * Google News 的 `oc`；剩下的参数按名字排序；路径末尾的 `/` 去掉；scheme 不参与（http 与 https 视为同一个）。
 * 没有路径也没有参数的（站点首页）返回 null：很多源给每条新闻同一个首页链接，不能当成同一篇。
 */

const TRACKING = /^(?:utm_[\w-]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|spm|from|ref|ref_src|source|share_token|oc|cmpid|ocid)$/i

export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const path = u.pathname.replace(/\/+$/, "")
  if (!path && !params.length) return null
  const host = u.hostname.toLowerCase().replace(/^www\./, "")
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
  return `${host}${path}${query ? `?${query}` : ""}`
}
