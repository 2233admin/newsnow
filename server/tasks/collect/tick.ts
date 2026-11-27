import process from "node:process"
import { getCollector } from "#/collector/runtime"
import { readCollectorConfig } from "#/collector/config"
import { getEnrichRuntime } from "#/enrich/runtime"

/**
 * 采集守护进程的一次心跳：由 nitro.config.ts 的 scheduledTasks 每分钟触发一次，
 * 只抓已到期的源（各源 interval 见 shared/sources.json）。
 * 手动触发：在运行中的服务里 `runTask("collect:tick")`；COLLECT_ENABLED=false 时什么也不做。
 */
export default defineTask({
  meta: {
    name: "collect:tick",
    description: "Collect due news sources into the observation database",
  },
  async run() {
    if (!readCollectorConfig(process.env).enabled) return { result: "disabled" }
    const collector = await getCollector()
    const { due, succeeded, failed, scheduled, purgedBefore } = await collector.tick()
    // 批量标注（#2188 补充）：采完之后在后台补一轮（单飞；没配模型就没有 tagger），不拖慢这一次心跳，出错只记日志
    void getEnrichRuntime().then(rt => rt.tagger?.run()).catch(e => logger.warn("enrich tag run failed", e))
    // Nitro 的 task 结果类型是字符串
    return { result: JSON.stringify({ scheduled, due: due.length, succeeded: succeeded.length, failed, purgedBefore }) }
  },
})
