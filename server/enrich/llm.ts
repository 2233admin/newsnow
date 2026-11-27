import process from "node:process"

/**
 * 批量标注与按需深读用的模型接口（#2188 补充）。模型与 key 由用户用环境变量配，支持两种协议：
 * - openai：OpenAI 兼容的 chat completions（POST {base}/chat/completions，Bearer 认证），OpenAI、DeepSeek、通义、本地 vLLM / Ollama 的兼容端点都走这个；
 * - anthropic：Anthropic Messages API（POST {base}/v1/messages，x-api-key 认证，anthropic-version 2023-06-01）。
 * 不引 SDK，直接 fetch，所以没有新依赖。没配（缺 provider、key、model 任何一项）就是 null：调用方跳过这一层，对应字段为 null，不报错。
 *
 * 环境变量（批量标注层）：
 *   ENRICH_LLM_PROVIDER   openai | anthropic
 *   ENRICH_LLM_API_KEY    密钥（只从环境读，不落库、不进日志）
 *   ENRICH_LLM_MODEL      模型名（不设默认值：该用哪个由用户定，便宜的小模型即可）
 *   ENRICH_LLM_BASE_URL   可选；openai 默认 https://api.openai.com/v1，anthropic 默认 https://api.anthropic.com
 * 按需深读层默认沿用上面的配置；要换更强的模型就设同名的 ENRICH_DEEP_LLM_*（四项里没设的沿用批量标注层的）。
 */

export type LlmProvider = "openai" | "anthropic"

export interface LlmConfig {
  provider: LlmProvider
  apiKey: string
  model: string
  baseUrl: string
}

const DEFAULT_BASE: Record<LlmProvider, string> = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com" }
const ANTHROPIC_VERSION = "2023-06-01"
/** 单次模型调用的总超时。待定：没有按所选模型的实际延迟定。 */
export const LLM_TIMEOUT_MS = 90_000

type Env = Record<string, string | undefined>

function read(env: Env, prefix: string): Partial<Record<"provider" | "apiKey" | "model" | "baseUrl", string>> {
  const get = (k: string) => env[`${prefix}_${k}`]?.trim() || undefined
  return { provider: get("PROVIDER"), apiKey: get("API_KEY"), model: get("MODEL"), baseUrl: get("BASE_URL") }
}

function build(parts: ReturnType<typeof read>): LlmConfig | null {
  const provider = parts.provider?.toLowerCase()
  if (provider !== "openai" && provider !== "anthropic") return null
  if (!parts.apiKey || !parts.model) return null
  return { provider, apiKey: parts.apiKey, model: parts.model, baseUrl: (parts.baseUrl ?? DEFAULT_BASE[provider]).replace(/\/+$/, "") }
}

/** 批量标注层的模型配置；没配齐返回 null。 */
export function readTagLlm(env: Env = process.env): LlmConfig | null {
  return build(read(env, "ENRICH_LLM"))
}

/** 按需深读层的模型配置：ENRICH_DEEP_LLM_* 里设了的覆盖批量标注层的，其余沿用；没配齐返回 null。 */
export function readDeepLlm(env: Env = process.env): LlmConfig | null {
  const base = read(env, "ENRICH_LLM")
  const deep = read(env, "ENRICH_DEEP_LLM")
  return build({
    provider: deep.provider ?? base.provider,
    apiKey: deep.apiKey ?? base.apiKey,
    model: deep.model ?? base.model,
    // 换了 provider 却没给新地址时不能沿用旧地址（会把 anthropic 的请求发给 openai 的地址）
    baseUrl: deep.baseUrl ?? (deep.provider && deep.provider !== base.provider ? undefined : base.baseUrl),
  })
}

export interface LlmRequest {
  system?: string
  user: string
  maxTokens: number
}

export type LlmCall = (req: LlmRequest) => Promise<string>

/** 模型调用失败（网络、HTTP 非 2xx、响应形状不对）。message 里不含 key。 */
export class LlmError extends Error {}

/** 造一个调用函数。fetchImpl 默认全局 fetch，测试里换成假的。 */
export function createLlm(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): LlmCall {
  return async (req) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    let url: string
    let body: unknown
    if (cfg.provider === "openai") {
      url = `${cfg.baseUrl}/chat/completions`
      headers.authorization = `Bearer ${cfg.apiKey}`
      body = {
        model: cfg.model,
        max_tokens: req.maxTokens,
        messages: [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.user }],
      }
    } else {
      url = `${cfg.baseUrl}/v1/messages`
      headers["x-api-key"] = cfg.apiKey
      headers["anthropic-version"] = ANTHROPIC_VERSION
      body = { model: cfg.model, max_tokens: req.maxTokens, ...(req.system ? { system: req.system } : {}), messages: [{ role: "user", content: req.user }] }
    }
    let res: Response
    try {
      res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(LLM_TIMEOUT_MS) })
    } catch (e) {
      throw new LlmError(`模型接口请求失败：${(e as Error).message}`)
    }
    const text = await res.text().catch(() => "")
    if (!res.ok) throw new LlmError(`模型接口返回 HTTP ${res.status}：${text.slice(0, 200)}`)
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new LlmError(`模型接口返回的不是 JSON：${text.slice(0, 100)}`)
    }
    const out = cfg.provider === "openai"
      ? json?.choices?.[0]?.message?.content
      : Array.isArray(json?.content) ? json.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("") : undefined
    if (typeof out !== "string" || !out) throw new LlmError(`模型接口的响应里没有文本：${text.slice(0, 100)}`)
    return out
  }
}
