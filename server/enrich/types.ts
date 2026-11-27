/**
 * 富化第二批字段的类型（#2188 补充）：对齐交易日、分类标注。字段形状是给 KATANAview 前端（#2189）用的契约，名字不要改。
 */

export type Market = "cn" | "us" | "crypto"
export const MARKETS: readonly Market[] = ["cn", "us", "crypto"]

/** 盘前 / 盘中 / 午休 / 盘后 / 休市日 */
export type Session = "pre" | "open" | "lunch" | "post" | "closed"
export const SESSIONS: readonly Session[] = ["pre", "open", "lunch", "post", "closed"]

/** 一条新闻在某个市场里对应的交易日与时段。 */
export interface Align {
  market: Market
  /** YYYY-MM-DD（该市场所在时区的日期） */
  tradeDate: string
  session: Session
}

/**
 * 对这条新闻本身的读法：positive 正面（读起来是好消息）/ negative 负面（坏消息）/ neutral 中性或无法判断。
 * 不是对价格涨跌的判断或预测（所以不叫 bull / bear，前端也不要渲染成「看涨 / 看跌」）。
 */
export type Direction = "positive" | "negative" | "neutral"
export const DIRECTIONS: readonly Direction[] = ["positive", "negative", "neutral"]

/**
 * 批量标注层的结果（每组一份，挂在组的「标注持有者」上：组里 seq 最小、没被规则层过滤的成员，通常是主条目；主条目被过滤时是后面第一个没被过滤的成员）。
 * 四个字段各自可以是 null：模型少返回了哪个就是哪个 null，不补、不造（themes 为 null = 模型没给题材字段；给了但没有是 []）。
 * 整个对象为 null = 这一组还没标过（没配模型、还在排队、整组都被规则层过滤、或失败到了上限）。
 */
export interface ItemTags {
  /** 影响类型：取自 server/enrich/config/impact-types.json 里该市场的分类表的名称 */
  impact: string | null
  direction: Direction | null
  /** 一句话要点 */
  gist: string | null
  /** 相关题材 / 板块 */
  themes: string[] | null
}

/** 规则层的过滤原因（稳定的代码，中文名见 FILTER_REASON_LABELS）。 */
export type FilterReason = "advert" | "stock_tout" | "ranking_list" | "market_roundup"
