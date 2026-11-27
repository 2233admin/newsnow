/**
 * 批量标注的评测（#2188 补充）：把人工标好的样本（gold）与模型的标注（predicted）逐条对比，算影响类型与方向的准确率。
 * 脚本 scripts/enrich-tag-eval.ts 与单测 test/enrich/tag-eval.test.ts 共用；写法仿 eval.ts（标的识别的评测）。
 *
 * 流程（需要人工）：1) `pnpm enrich:tag-eval --sample 100 --out sample.json` 从库里随机抽 100 个已标注的组，写出标题与模型的标注；
 * 2) 人工在 sample.json 里给每条的 gold.impact（分类表里的名称）与 gold.direction（bull / bear / neutral）填上；
 * 3) `pnpm enrich:tag-eval --score sample.json` 报准确率。gold 没填的条目不计入分母。
 */

export interface TagSample {
  seq: number
  title: string
  market: string
  predicted: { impact: string | null, direction: string | null, gist: string | null, themes: string[] | null }
  /** 人工标注；null = 还没标 */
  gold: { impact: string | null, direction: string | null } | null
}

export interface TagScore {
  samples: number
  /** gold.impact 填了的条数 */
  impactLabeled: number
  impactCorrect: number
  impactAccuracy: number
  directionLabeled: number
  directionCorrect: number
  directionAccuracy: number
  /** 模型没给出影响类型（null）的条数（在已标注的里面）：算错 */
  impactMissing: number
  wrong: { seq: number, title: string, gold: string, predicted: string | null }[]
}

export function scoreTags(samples: TagSample[]): TagScore {
  let impactLabeled = 0
  let impactCorrect = 0
  let impactMissing = 0
  let directionLabeled = 0
  let directionCorrect = 0
  const wrong: TagScore["wrong"] = []
  for (const s of samples) {
    const g = s.gold
    if (g?.impact) {
      impactLabeled++
      if (s.predicted.impact === null) impactMissing++
      if (s.predicted.impact === g.impact) impactCorrect++
      else wrong.push({ seq: s.seq, title: s.title, gold: g.impact, predicted: s.predicted.impact })
    }
    if (g?.direction) {
      directionLabeled++
      if (s.predicted.direction === g.direction) directionCorrect++
    }
  }
  return {
    samples: samples.length,
    impactLabeled,
    impactCorrect,
    impactAccuracy: impactLabeled ? impactCorrect / impactLabeled : Number.NaN,
    directionLabeled,
    directionCorrect,
    directionAccuracy: directionLabeled ? directionCorrect / directionLabeled : Number.NaN,
    impactMissing,
    wrong,
  }
}
