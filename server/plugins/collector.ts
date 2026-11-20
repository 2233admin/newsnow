import process from "node:process"
import { Collector } from "#/collector/scheduler"
import { collectorSources, getObservationStore } from "#/collector"

/**
 * 服务起来就开始定时采集。
 * 只在常驻进程里跑（Node、Bun）：Cloudflare Pages 与 Vercel Edge 是按请求起的，没有地方放定时器。
 * 设 ENABLE_COLLECTOR=false 可以关掉。
 */
export default defineNitroPlugin((nitro) => {
  if (process.env.ENABLE_COLLECTOR === "false") return
  const preset = import.meta.preset ?? ""
  if (preset.includes("cloudflare") || preset.includes("vercel")) return

  let collector: Collector | undefined
  getObservationStore().then((store) => {
    collector = new Collector({
      store,
      sources: collectorSources(),
      onError: (source, error) => logger.error(`collect ${source} failed`, error),
    })
    collector.start()
    logger.success(`collector started`)
  }).catch(error => logger.error("failed to start collector", error))

  nitro.hooks.hook("close", () => collector?.stop())
})
