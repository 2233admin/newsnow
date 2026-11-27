import { describe, expect, it } from "vitest"
import { scoreTags } from "#/enrich/tag-eval"
import type { TagSample } from "#/enrich/tag-eval"

const s = (seq: number, predicted: Partial<TagSample["predicted"]>, gold: TagSample["gold"]): TagSample => ({ seq, title: `t${seq}`, market: "cn", predicted: { impact: null, direction: null, gist: null, themes: null, ...predicted }, gold })

describe("影响类型准确率的评测", () => {
  it("只算人工标了 gold 的；模型没给类型（null）算错；方向单独算", () => {
    const r = scoreTags([
      s(1, { impact: "公告", direction: "positive" }, { impact: "公告", direction: "positive" }),
      s(2, { impact: "公告", direction: "positive" }, { impact: "政策与监管", direction: "negative" }),
      s(3, { impact: null, direction: "neutral" }, { impact: "公告", direction: "neutral" }),
      s(4, { impact: "其他" }, null), // 没标 gold，不计
      s(5, { impact: "公告" }, { impact: null, direction: null }), // gold 都是空，不计
    ])
    expect(r).toMatchObject({ samples: 5, impactLabeled: 3, impactCorrect: 1, impactMissing: 1, directionLabeled: 3, directionCorrect: 2 })
    expect(r.impactAccuracy).toBeCloseTo(1 / 3)
    expect(r.directionAccuracy).toBeCloseTo(2 / 3)
    expect(r.wrong.map(w => w.seq)).toEqual([2, 3])
  })

  it("一条 gold 也没有：准确率是 NaN（报「未测」），不是 0 或 1", () => {
    expect(scoreTags([s(1, { impact: "公告" }, null)]).impactAccuracy).toBeNaN()
  })
})
