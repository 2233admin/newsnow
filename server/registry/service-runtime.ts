import process from "node:process"
import { readNetPolicy } from "./net"
import { fetchText, getUserSourceStore } from "./runtime"
import { createSourceService } from "./service"
import { getObservationStore } from "#/collector/runtime"

/** API 用的服务层装配（观测库的健康记录与用户源配置在同一个库里）。 */
export async function getSourceService() {
  return createSourceService({
    store: await getUserSourceStore(),
    observations: await getObservationStore(),
    fetchText,
    policy: readNetPolicy(process.env),
  })
}
