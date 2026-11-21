import { describe, expect, it } from "vitest"
import { T0, descriptors, feedWorld, ingest, row } from "../feed/helpers"
import { BACKFILL_QUIET_MS, collectorLooksActive } from "#/enrich/enrich"

// 审阅 #8 第 5 项：回填和服务同时跑会让分组出链，回填脚本靠「最近有没有采集写入」拒绝。
describe("回填防呆", () => {
  it("空库没有写入记录；采集写了条目或心跳之后，记录的是最近一次", async () => {
    const w = await feedWorld(descriptors(), { enrich: true })
    expect(await w.enricher.store.lastCollectorWriteAt()).toBe(0)
    await ingest(w, "jin10", [row("a")], T0)
    expect(await w.enricher.store.lastCollectorWriteAt()).toBe(T0)
    await w.store.recordSuccess("jin10", T0 + 90_000, 1)
    expect(await w.enricher.store.lastCollectorWriteAt()).toBe(T0 + 90_000)
    await w.store.recordFailure("hackernews", T0 + 200_000, new Error("x"))
    expect(await w.enricher.store.lastCollectorWriteAt()).toBe(T0 + 200_000)
  })

  it("安静窗口之内算还在写（脚本拒绝），窗口之外放行", () => {
    expect(collectorLooksActive(T0, T0 + BACKFILL_QUIET_MS - 1)).toBe(true)
    expect(collectorLooksActive(T0, T0 + BACKFILL_QUIET_MS)).toBe(false)
    expect(collectorLooksActive(0, T0)).toBe(false) // 空库
  })
})
