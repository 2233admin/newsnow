/**
 * 同花顺 7×24 快讯（https://news.10jqka.com.cn/realtimenews.html）。
 *
 * 接口：GET https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=50
 * 返回 JSON：{ code: "200", data: { list: [...] } }，无需登录与 cookie；ctime 是 Unix 秒。
 * 出处：与 RSSHub 路由 10jqka/realtimenews（lib/routes/10jqka/realtimenews.ts）用的是同一个接口；
 * 接口返回的 filter 列表（全部 / 重要 / A股 / 港股 / 美股 …）与该页面的频道一致。
 * 读取日期 2026-11-21（沙箱直连，实测 200，pagesize=100 时覆盖约 19 小时）。
 * 页面里的脚本经 CDN 加载，页面源码里没直接看到这个地址，页面是否同一个接口「待核对」。
 * robots.txt 读取日期同上：news.10jqka.com.cn/robots.txt 返回 200 且为空，没有禁止项。
 *
 * 字段：import 为 "0" 的是普通快讯，非 "0"（实测见 "3"）是同花顺标成重要的，红色标记；
 * digest 是正文，放进 hover，和 jin10 的做法一致。
 */
interface ThsItem {
  id: string
  title: string
  digest?: string
  url: string
  /** Unix 秒，字符串 */
  ctime: string
  /** "0" 普通，其余重要 */
  import?: string
}

interface ThsRes {
  code: string
  msg?: string
  data?: {
    list?: ThsItem[]
  }
}

export default defineSource(async () => {
  const res: ThsRes = await myFetch("https://news.10jqka.com.cn/tapp/news/push/stock/", {
    query: { page: 1, tag: "", track: "website", pagesize: 50 },
    headers: { Referer: "https://news.10jqka.com.cn/realtimenews.html" },
  })
  const list = res?.data?.list
  // code 不是 "200" 或没有 list 时抛错，让采集器记一次失败，而不是当成「这一轮没有新闻」
  if (String(res?.code) !== "200" || !Array.isArray(list)) {
    throw new TypeError(`同花顺快讯接口返回异常：code=${res?.code} msg=${res?.msg}`)
  }
  return list.filter(k => k.id && k.title && k.url).map(k => ({
    id: k.id,
    title: k.title,
    url: k.url,
    pubDate: Number(k.ctime) * 1000,
    extra: {
      hover: k.digest || undefined,
      info: !!k.import && k.import !== "0" && "✰",
    },
  }))
})
