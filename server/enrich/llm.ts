import process from "node:process"
import { logger } from "../utils/logger"

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
 *   ENRICH_LLM_MAX_TOKENS_FIELD  可选，只对 openai 兼容有效：max_tokens（默认）| max_completion_tokens。
 *       OpenAI 官方文档说 max_tokens 已弃用，且与 o 系列推理模型不兼容（要用 max_completion_tokens；文档：developers.openai.com/api/reference/…/chat/…/create，
 *       2026-11-27 读到）。很多兼容服务（DeepSeek、vLLM、Ollama）只认 max_tokens，所以默认不动；用 o 系列、gpt-5 系列（待核实）时设成 max_completion_tokens。
 *       推理模型的思考 token 也算在这个上限里，上限不够时正文会被截断（我们的解析能救回已完整的条目）。anthropic 协议的字段名固定是 max_tokens，不受影响。
 * 按需深读层默认沿用上面的配置；要换更强的模型就设同名的 ENRICH_DEEP_LLM_*（四项里没设的沿用批量标注层的）。
 */

export type LlmProvider = "openai" | "anthropic"

/** openai 兼容请求里「输出 token 上限」用哪个字段名。 */
export type MaxTokensField = "max_tokens" | "max_completion_tokens"
const MAX_TOKENS_FIELDS: readonly MaxTokensField[] = ["max_tokens", "max_completion_tokens"]

export interface LlmConfig {
  provider: LlmProvider
  apiKey: string
  model: string
  baseUrl: string
  /** 只对 openai 有效；不给 = max_tokens */
  maxTokensField?: MaxTokensField
}

const DEFAULT_BASE: Record<LlmProvider, string> = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com" }
const ANTHROPIC_VERSION = "2023-06-01"
/** 单次模型调用的总超时。待定：没有按所选模型的实际延迟定。 */
export const LLM_TIMEOUT_MS = 90_000

type Env = Record<string, string | undefined>

function read(env: Env, prefix: string): Partial<Record<"provider" | "apiKey" | "model" | "baseUrl" | "maxTokensField", string>> {
  const get = (k: string) => env[`${prefix}_${k}`]?.trim() || undefined
  return { provider: get("PROVIDER"), apiKey: get("API_KEY"), model: get("MODEL"), baseUrl: get("BASE_URL"), maxTokensField: get("MAX_TOKENS_FIELD") }
}

function build(parts: ReturnType<typeof read>): LlmConfig | null {
  const provider = parts.provider?.toLowerCase()
  if (provider !== "openai" && provider !== "anthropic") return null
  if (!parts.apiKey || !parts.model) return null
  const field = parts.maxTokensField?.toLowerCase()
  if (field && !(MAX_TOKENS_FIELDS as readonly string[]).includes(field)) logger.warn(`enrich llm：MAX_TOKENS_FIELD「${parts.maxTokensField}」不认识（只有 ${MAX_TOKENS_FIELDS.join(" / ")}），按默认的 max_tokens 发`)
  const cfg: LlmConfig = { provider, apiKey: parts.apiKey, model: parts.model, baseUrl: (parts.baseUrl ?? DEFAULT_BASE[provider]).replace(/\/+$/, "") }
  if (field && (MAX_TOKENS_FIELDS as readonly string[]).includes(field)) cfg.maxTokensField = field as MaxTokensField
  return cfg
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
    // token 字段名跟着模型走：深读换了模型（或换了 provider）就不沿用标注层的写法，没单独给就按默认
    maxTokensField: deep.maxTokensField ?? (deep.provider || deep.model || deep.baseUrl ? undefined : base.maxTokensField),
  })
}

export interface LlmRequest {
  system?: string
  user: string
  maxTokens: number
}

export type LlmCall = (req: LlmRequest) => Promise<string>

/**
 * 模型调用失败（网络、HTTP 非 2xx、响应形状不对）。message 里不含 key，也不含上游响应正文：
 * 网关、代理、部分兼容服务会在错误正文里回显请求头（含 Authorization / x-api-key），而这条 message 会进日志，
 * 还会经 GET /api/feed/deep 与 MCP 的 read_item_deep 返回给调用方。所以只留 HTTP 状态码与上游错误的「类型」（短的标识符），
 * 其余一律不拼。
 */
export class LlmError extends Error {}

/** 上游错误正文里的错误类型（OpenAI：error.type / error.code；Anthropic：error.type）。只收短的标识符，别的（含 message）一概不要。 */
function upstreamErrorType(text: string, apiKey: string): string | undefined {
  try {
    const e = JSON.parse(text)?.error
    for (const v of [e?.type, e?.code]) {
      if (typeof v === "string" && /^[\w.-]{1,64}$/.test(v) && !v.includes(apiKey)) return v
    }
  } catch {}
  return undefined
}

/** 把 key 从一段文字里抹掉（兜底：上游或 fetch 实现的异常信息里万一带着 key）。太短的 key 不抹（会误伤普通文字），但配置里的 key 实际都远长于此。 */
function scrub(text: string, apiKey: string): string {
  return apiKey.length >= 6 ? text.split(apiKey).join("***") : text
}

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
        [cfg.maxTokensField ?? "max_tokens"]: req.maxTokens,
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
      // redirect: "error"：配置的地址若 3xx 到别处，fetch 默认会跟过去，而 x-api-key（不是 authorization）不会被剥掉，key 就送给了另一个 origin
      res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(LLM_TIMEOUT_MS), redirect: "error" })
    } catch (e) {
      const cause = (e as { cause?: { message?: unknown } }).cause?.message
      throw new LlmError(scrub(`模型接口请求失败：${(e as Error).message}${typeof cause === "string" ? `（${cause}）` : ""}`, cfg.apiKey))
    }
    const text = await res.text().catch(() => "")
    if (!res.ok) {
      const type = upstreamErrorType(text, cfg.apiKey)
      throw new LlmError(`模型接口返回 HTTP ${res.status}${type ? `（${type}）` : ""}`)
    }
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      throw new LlmError("模型接口返回的不是 JSON")
    }
    const out = cfg.provider === "openai"
      ? json?.choices?.[0]?.message?.content
      : Array.isArray(json?.content) ? json.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("") : undefined
    if (typeof out !== "string" || !out) throw new LlmError("模型接口的响应里没有文本")
    return out
  }
}
