import type { AllSourceID } from "@shared/types"
import defu from "defu"
import type { RSSHubOption, RSSHubInfo as RSSHubResponse, SourceGetter, SourceOption } from "#/types"

type R = Partial<Record<AllSourceID, SourceGetter>>
export function defineSource(source: SourceGetter): SourceGetter
export function defineSource(source: R): R
export function defineSource(source: SourceGetter | R): SourceGetter | R {
  return source
}

export function defineRSSSource(url: string, option?: SourceOption): SourceGetter {
  return async () => {
    const data = await rss2json(url, option?.fetchText)
    if (!data?.items.length) throw new Error("Cannot fetch rss data")
    return data.items.map(item => ({
      title: item.title,
      url: item.link,
      id: item.link,
      pubDate: !option?.hiddenDate ? item.created : undefined,
    }))
  }
}

/** 用户源用的 RSSHub 实例；路由必须落在这个域名下（server/registry/spec.ts 的 checkRsshubRoute）。 */
export const RSSHUB_BASE = "https://rsshub.rssforever.com"

function parseRSSHubJSON(text: string): RSSHubResponse {
  let data: RSSHubResponse | undefined
  try {
    data = JSON.parse(text)
  } catch {}
  if (!Array.isArray(data?.items)) throw new Error("RSSHub 返回的不是 JSON Feed")
  return data!
}

export function defineRSSHubSource(route: string, RSSHubOptions?: RSSHubOption, sourceOption?: SourceOption): SourceGetter {
  return async () => {
    // "https://rsshub.pseudoyu.com"
    const url = new URL(route, RSSHUB_BASE)
    url.searchParams.set("format", "json")
    RSSHubOptions = defu<RSSHubOption, RSSHubOption[]>(RSSHubOptions, {
      sorted: true,
    })

    Object.entries(RSSHubOptions).forEach(([key, value]) => {
      url.searchParams.set(key, value.toString())
    })
    // 用户源注入带超时与体积上限的 fetchText（server/registry/net.ts）；内置源不传，仍走 myFetch
    const data: RSSHubResponse = sourceOption?.fetchText
      ? parseRSSHubJSON(await sourceOption.fetchText(url.toString()))
      : await myFetch(url)
    return data.items.map(item => ({
      title: item.title,
      url: item.url,
      id: item.id ?? item.url,
      pubDate: !sourceOption?.hiddenDate ? item.date_published : undefined,
    }))
  }
}
