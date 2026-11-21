import { guarded } from "#/registry/http"
import { getPresetService } from "#/registry/preset-runtime"

/** 预置订阅包：每个源的配置、出处、当前状态（available / enabled / disabled）与采集健康。只给本机，见 registry/http.ts。 */
export default defineEventHandler(event => guarded(event, async () => ({
  sources: await (await getPresetService()).list(),
})))
