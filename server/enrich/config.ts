import process from "node:process"
import { logger } from "../utils/logger"

/**
 * 富化的配置文件（#2188 补充）：server/enrich/config/ 下的三份 JSON ——
 * calendar.json（交易日历与时段）、source-markets.json（无标的新闻按来源的默认市场）、impact-types.json（影响类型分类表）。
 *
 * 默认读随代码打包的那一份。用户要改而不想改代码：设 ENRICH_CONFIG_DIR 指向一个目录，里面放同名的 JSON 文件（只放要改的那几份也行），
 * 进程启动后第一次用到时读一次，改了要重启。文件读不出来、JSON 坏了或没通过校验时，记一条警告并退回打包的那份，不让一个配置笔误拖垮采集入库。
 * 只有 Node 系的运行时读得了文件（process.getBuiltinModule）；Cloudflare 上没有，一直用打包的那份。
 */

export type ConfigName = "calendar" | "source-markets" | "impact-types"

interface Fs {
  existsSync: (p: string) => boolean
  readFileSync: (p: string, enc: "utf8") => string
}

function nodeFs(): Fs | undefined {
  try {
    return (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:fs") as Fs | undefined
  } catch {
    return undefined
  }
}

/** 读覆盖文件；没设目录、没有这份文件、读不出来都返回 undefined。 */
export function readOverride(name: ConfigName, env: Record<string, string | undefined> = process.env): { path: string, json: unknown } | undefined {
  const dir = env.ENRICH_CONFIG_DIR
  if (!dir) return undefined
  const fs = nodeFs()
  if (!fs) return undefined
  const path = `${dir.replace(/[\\/]+$/, "")}/${name}.json`
  try {
    if (!fs.existsSync(path)) return undefined
    return { path, json: JSON.parse(fs.readFileSync(path, "utf8")) }
  } catch (e) {
    logger.warn(`enrich config ${path} 读不出来，改用打包的 ${name}.json：${(e as Error).message}`)
    return undefined
  }
}

/** 取一份配置：覆盖文件通过校验就用它，否则用打包的。validate 通不过时抛错。 */
export function resolveConfig<T>(name: ConfigName, bundled: unknown, validate: (x: unknown) => T, env: Record<string, string | undefined> = process.env): T {
  const override = readOverride(name, env)
  if (override) {
    try {
      return validate(override.json)
    } catch (e) {
      logger.warn(`enrich config ${override.path} 没通过校验，改用打包的 ${name}.json：${(e as Error).message}`)
    }
  }
  return validate(bundled)
}

export class ConfigError extends Error {}

export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

export function need(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ConfigError(message)
}
