import process from "node:process"
import { createActions } from "./actions"
import { AuditStore } from "./audit"
import { getObservationStore } from "#/collector/runtime"
import { getSourceService } from "#/registry/service-runtime"
import { getUserSourceStore } from "#/registry/runtime"

/**
 * 动作层的运行时装配：HTTP 的 /api/collector/… 与 MCP 的 /mcp 拿到的是同一个实例，
 * 所以改动的串行锁是同一把。INIT_TABLE=false 时不建表（同 collector/runtime.ts）。
 */
let promise: ReturnType<typeof build> | undefined
async function build() {
  const audit = new AuditStore(useDatabase())
  if (process.env.INIT_TABLE !== "false") await audit.init()
  await getObservationStore()
  return createActions({ store: await getUserSourceStore(), service: await getSourceService(), audit })
}

export function getActions() {
  promise ??= build().catch((e) => {
    promise = undefined
    throw e
  })
  return promise
}
