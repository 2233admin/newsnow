import { describe, expect, it } from "vitest"
import { memoryStore } from "./helpers"
import { getHealthReport } from "#/collector/health"

describe("getHealthReport", () => {
  it("每个会被采集的源一行：没抓过的 pending、最近成功的 ok、最近失败的 failing；redirect 不出现", async () => {
    const { store } = await memoryStore()
    await store.recordSuccess("good", 1000, 5)
    await store.recordFailure("bad", 1000, new Error("HTTP 500"))
    await store.recordFailure("bad", 2000, new Error("HTTP 500"))

    const report = await getHealthReport(
      store,
      {
        good: { interval: 120_000 },
        bad: { interval: 600_000 },
        fresh: { interval: 600_000 },
        alias: { interval: 600_000, redirect: "good" as any },
      },
      { good: async () => [], bad: async () => [], fresh: async () => [], alias: async () => [] },
    )
    expect(report.map(r => [r.sourceId, r.status])).toEqual([["good", "ok"], ["bad", "failing"], ["fresh", "pending"]])
    expect(report[1]).toMatchObject({ consecutiveFailures: 2, lastError: "HTTP 500", lastSuccessAt: null, interval: 600_000 })
    expect(report[2]).toMatchObject({ lastAttemptAt: null, lastSuccessAt: null })
  })
})
