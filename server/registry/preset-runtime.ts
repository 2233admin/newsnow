import { loadPack } from "./presets"
import { createPresetService } from "./preset-service"
import { getSourceService } from "./service-runtime"
import { RSSHUB_BASE } from "#/utils/source"
import { getObservationStore } from "#/collector/runtime"

/** 预置包在进程里只解析一次；包坏了（不合模块 2 的规则）在第一次请求时抛错，测试里另有一条保证它不会坏。 */
const pack = loadPack(RSSHUB_BASE)

export async function getPresetService() {
  return createPresetService({ service: await getSourceService(), observations: await getObservationStore(), pack })
}
