import * as cheerio from "cheerio"
import type { NewsItem } from "@shared/types"

/**
 * 淘股吧综合吧热帖（https://www.tgb.cn/bbs/）。
 *
 * 页面：GET https://www.tgb.cn/bbs/，服务端渲染的 HTML，无需登录与 cookie（沙箱直连实测 200，约 220 KB）。
 * 列表在 `.Nbbs-tiezi-lists`，一页 69 行，默认按最后回帖时间倒序，也就是正在被讨论的帖子在前；
 * 每行：标题与链接 `a.mw300[href=/a/<帖子号>]`（title 属性是完整标题）、「评论 / 浏览」、回帖日期、作者、发帖日期。
 * 读取日期 2026-11-21。
 * robots.txt（https://www.tgb.cn/robots.txt，同日读取）只禁止 /view?topicID=*、/Reply/*、/new/ngb/*、/new/dav/*，/bbs/ 与 /a/ 不在其中。
 * 页面没有给年份：「MM-DD HH:mm」按北京时间解析，补上今年；补完比当前时间晚一天以上的，说明是跨年前的帖子，取去年。
 *
 * 为什么不用「精华加油」(/jinghua/)：那是人工挑选的精华帖，量少且不是热度；综合吧默认序更接近热帖。
 */

const baseURL = "https://www.tgb.cn"
const DAY = 24 * 60 * 60 * 1000

/** 「11-19 21:05」或「2025-12-30 10:00」（北京时间）→ 毫秒；认不出返回 undefined */
export function parseTaogubaDate(text: string, now = Date.now()): number | undefined {
  const m = text.trim().match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/)
  if (!m) return undefined
  const [, year, month, day, hour, minute] = m
  const pad = (n: string) => n.padStart(2, "0")
  const at = (y: number) => tranformToUTC(`${y}-${pad(month)}-${pad(day)} ${pad(hour)}:${minute}`)
  if (year) return at(Number(year))
  const thisYear = Number(new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 4))
  const t = at(thisYear)
  return t > now + DAY ? at(thisYear - 1) : t
}

export default defineSource(async () => {
  const html: string = await myFetch(`${baseURL}/bbs/`, {
    headers: { Referer: `${baseURL}/` },
  })
  const $ = cheerio.load(html)
  const rows = $(".Nbbs-tiezi-lists")
  const news: NewsItem[] = []
  rows.each((_, el) => {
    const a = $(el).find(".middle-list-tittle a.mw300").first()
    const href = a.attr("href")
    const id = href?.match(/^\/a\/([A-Za-z0-9]+)/)?.[1]
    const title = (a.attr("title") || a.text()).replace(/\s+/g, " ").trim()
    if (!id || !title) return
    const counts = $(el).find(".middle-list-talk").text().replace(/\s+/g, " ").trim()
    const author = $(el).find(".middle-list-user a").first().text().trim()
    news.push({
      id,
      title,
      url: `${baseURL}/a/${id}`,
      pubDate: parseTaogubaDate($(el).find(".middle-list-post").text()),
      extra: {
        info: counts && `评论/浏览 ${counts.replace(/\s/g, "")}`,
        hover: author ? `作者：${author}` : undefined,
      },
    })
  })
  // 页面结构变了会解析出 0 行：抛错让采集器记失败，不要当成「没有热帖」
  if (!news.length) throw new Error("淘股吧综合吧没有解析出任何帖子（页面结构可能变了）")
  return news
})
