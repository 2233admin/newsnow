/**
 * 标的识别的评测（#2188）：把标注样本（test/fixtures/enrich-sample.json）与识别结果逐条对比，算准确率与召回率。
 * 脚本（scripts/enrich-eval.ts）与回归测试（test/enrich/accuracy.test.ts）共用。
 *
 * 口径：
 * - 按（标题，标的）对计，微平均。准确率 = 识别出的对里标注里也有的比例；召回率 = 标注的对里识别出来的比例。
 * - 同一家公司的几个股份类别（GOOG 与 GOOGL、BRK.A 与 BRK.B）算同一个标的：标注与识别落在同一类里就算对。
 * - 「词典内召回」只算标注里有、且 id 在词典里的对（词典没收的新股、小盘股不算漏）；「总召回」算全部标注。两个数分开报，
 *   差就是词典覆盖的缺口。
 */

export interface Labeled {
  id: string
  source: string
  title: string
  /** 标注的标的（品种 id）；没有就是空数组 */
  symbols: string[]
  /** 标注者的备注：拿不准的取舍、为什么没标 */
  note?: string
}

const SIBLINGS = [["GOOG.XNAS", "GOOGL.XNAS"], ["BRK.A.XNYS", "BRK.B.XNYS"]]
const klass = (id: string) => SIBLINGS.find(g => g.includes(id))?.[0] ?? id

export interface Score {
  titles: number
  titlesWithGold: number
  goldPairs: number
  goldInDict: number
  predicted: number
  tp: number
  tpInDict: number
  precision: number
  recall: number
  recallInDict: number
  falsePositives: { title: string, id: string }[]
  misses: { title: string, id: string, inDict: boolean }[]
}

export function score(samples: Labeled[], predict: (title: string) => string[], inDict: (id: string) => boolean): Score {
  let goldPairs = 0
  let goldInDict = 0
  let predicted = 0
  let tp = 0
  let tpInDict = 0
  const falsePositives: Score["falsePositives"] = []
  const misses: Score["misses"] = []
  for (const s of samples) {
    const gold = new Set(s.symbols.map(klass))
    const got = new Set(predict(s.title).map(klass))
    for (const g of gold) {
      goldPairs++
      const dict = inDict(g)
      if (dict) goldInDict++
      if (got.has(g)) {
        tp++
        if (dict) tpInDict++
      } else {
        misses.push({ title: s.title, id: g, inDict: dict })
      }
    }
    for (const p of got) {
      predicted++
      if (!gold.has(p)) falsePositives.push({ title: s.title, id: p })
    }
  }
  return {
    titles: samples.length,
    titlesWithGold: samples.filter(s => s.symbols.length).length,
    goldPairs,
    goldInDict,
    predicted,
    tp,
    tpInDict,
    precision: predicted ? tp / predicted : 1,
    recall: goldPairs ? tp / goldPairs : 1,
    recallInDict: goldInDict ? tpInDict / goldInDict : 1,
    falsePositives,
    misses,
  }
}
