import http from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"
import { logger } from "../../server/utils/logger"
import { LlmError, createLlm, readDeepLlm, readTagLlm } from "#/enrich/llm"

const ok = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })

describe("模型配置来自环境变量", () => {
  it("缺 provider、key、model 任何一项都是 null（这一层跳过，不报错）", () => {
    expect(readTagLlm({})).toBeNull()
    expect(readTagLlm({ ENRICH_LLM_PROVIDER: "openai", ENRICH_LLM_API_KEY: "k" })).toBeNull()
    expect(readTagLlm({ ENRICH_LLM_PROVIDER: "openai", ENRICH_LLM_MODEL: "m" })).toBeNull()
    expect(readTagLlm({ ENRICH_LLM_API_KEY: "k", ENRICH_LLM_MODEL: "m" })).toBeNull()
    expect(readTagLlm({ ENRICH_LLM_PROVIDER: "gemini", ENRICH_LLM_API_KEY: "k", ENRICH_LLM_MODEL: "m" })).toBeNull()
  })

  it("默认地址按协议；自填地址去掉结尾斜杠", () => {
    expect(readTagLlm({ ENRICH_LLM_PROVIDER: "openai", ENRICH_LLM_API_KEY: "k", ENRICH_LLM_MODEL: "m" })?.baseUrl).toBe("https://api.openai.com/v1")
    expect(readTagLlm({ ENRICH_LLM_PROVIDER: "Anthropic", ENRICH_LLM_API_KEY: "k", ENRICH_LLM_MODEL: "m" })?.baseUrl).toBe("https://api.anthropic.com")
    expect(readTagLlm({ ENRICH_LLM_PROVIDER: "openai", ENRICH_LLM_API_KEY: "k", ENRICH_LLM_MODEL: "m", ENRICH_LLM_BASE_URL: "http://localhost:8000/v1//" })?.baseUrl).toBe("http://localhost:8000/v1")
  })

  it("深读默认沿用批量标注的配置；设了 ENRICH_DEEP_LLM_* 的项覆盖；换 provider 不沿用旧地址", () => {
    const base = { ENRICH_LLM_PROVIDER: "openai", ENRICH_LLM_API_KEY: "k1", ENRICH_LLM_MODEL: "small", ENRICH_LLM_BASE_URL: "http://localhost:8000/v1" }
    expect(readDeepLlm(base)).toMatchObject({ model: "small", apiKey: "k1", baseUrl: "http://localhost:8000/v1" })
    expect(readDeepLlm({ ...base, ENRICH_DEEP_LLM_MODEL: "big" })).toMatchObject({ model: "big", apiKey: "k1", provider: "openai" })
    expect(readDeepLlm({ ...base, ENRICH_DEEP_LLM_PROVIDER: "anthropic", ENRICH_DEEP_LLM_API_KEY: "k2", ENRICH_DEEP_LLM_MODEL: "big" })).toMatchObject({ provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k2" })
    expect(readDeepLlm({})).toBeNull()
    // 标注没配、只配了深读
    expect(readDeepLlm({ ENRICH_DEEP_LLM_PROVIDER: "openai", ENRICH_DEEP_LLM_API_KEY: "k", ENRICH_DEEP_LLM_MODEL: "m" })).toMatchObject({ model: "m" })
  })
})

describe("两种协议的请求与响应", () => {
  it("openai 兼容：POST {base}/chat/completions，Bearer 认证，system + user，取 choices[0].message.content", async () => {
    let seen: { url: string, init: RequestInit } | undefined
    const llm = createLlm({ provider: "openai", apiKey: "sk-secret", model: "m1", baseUrl: "http://llm.local/v1" }, (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return ok({ choices: [{ message: { content: "你好" } }] })
    }) as unknown as typeof fetch)
    expect(await llm({ system: "sys", user: "usr", maxTokens: 100 })).toBe("你好")
    expect(seen!.url).toBe("http://llm.local/v1/chat/completions")
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-secret")
    expect(JSON.parse(seen!.init.body as string)).toEqual({ model: "m1", max_tokens: 100, messages: [{ role: "system", content: "sys" }, { role: "user", content: "usr" }] })
  })

  it("anthropic：POST {base}/v1/messages，x-api-key 与 anthropic-version，system 在顶层，拼接 text 块", async () => {
    let seen: { url: string, init: RequestInit } | undefined
    const llm = createLlm({ provider: "anthropic", apiKey: "sk-ant", model: "m2", baseUrl: "https://api.anthropic.com" }, (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return ok({ content: [{ type: "text", text: "甲" }, { type: "thinking", thinking: "x" }, { type: "text", text: "乙" }] })
    }) as unknown as typeof fetch)
    expect(await llm({ system: "sys", user: "usr", maxTokens: 50 })).toBe("甲乙")
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages")
    const h = seen!.init.headers as Record<string, string>
    expect(h["x-api-key"]).toBe("sk-ant")
    expect(h["anthropic-version"]).toBe("2023-06-01")
    expect(h.authorization).toBeUndefined()
    expect(JSON.parse(seen!.init.body as string)).toEqual({ model: "m2", max_tokens: 50, system: "sys", messages: [{ role: "user", content: "usr" }] })
  })

  it("hTTP 错误、网络错误、非 JSON、没有文本都是 LlmError，且错误信息里没有 key", async () => {
    const cfg = { provider: "openai", apiKey: "sk-secret", model: "m", baseUrl: "http://x/v1" } as const
    const cases: (() => Promise<Response>)[] = [
      async () => ok({ error: { message: "rate limited" } }, 429),
      async () => {
        throw new Error("connect ECONNREFUSED")
      },
      async () => ok("<html>bad gateway</html>"),
      async () => ok({ choices: [] }),
    ]
    for (const make of cases) {
      const llm = createLlm(cfg, make as unknown as typeof fetch)
      const err = await llm({ user: "x", maxTokens: 10 }).catch(e => e)
      expect(err).toBeInstanceOf(LlmError)
      expect(String(err.message)).not.toContain("sk-secret")
    }
  })
})

describe("m2：错误信息不含 key、不含上游响应正文；不跟随重定向", () => {
  const KEY = "sk-SECRETKEY-1234567890"
  const cfg = { provider: "openai", apiKey: KEY, model: "m", baseUrl: "http://x.test/v1" } as const
  const fail = async (make: (init: RequestInit) => Promise<Response>, c: Parameters<typeof createLlm>[0] = cfg) => {
    const llm = createLlm(c, (async (_u: string, init: RequestInit) => make(init)) as unknown as typeof fetch)
    return await llm({ user: "x", maxTokens: 10 }).catch(e => e)
  }
  const authOf = (init: RequestInit) => (init.headers as Record<string, string>).authorization

  it("上游把 Authorization 原样回显在 401 正文里：message 只有状态码", async () => {
    const err = await fail(async init => ok(`{"error":"bad auth: ${authOf(init)}"}`, 401))
    expect(err).toBeInstanceOf(LlmError)
    expect(err.message).toBe("模型接口返回 HTTP 401")
    expect(err.message).not.toContain(KEY)
  })

  it("上游的错误类型（OpenAI error.type / Anthropic error.type）保留，message 字段不要；类型字段里塞了 key 的丢掉", async () => {
    const a = await fail(async init => ok({ error: { type: "invalid_request_error", message: `Incorrect API key provided: ${authOf(init)}` } }, 401))
    expect(a.message).toBe("模型接口返回 HTTP 401（invalid_request_error）")
    const b = await fail(async () => ok({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401), { ...cfg, provider: "anthropic" })
    expect(b.message).toBe("模型接口返回 HTTP 401（authentication_error）")
    const c = await fail(async () => ok({ error: { type: KEY } }, 401))
    expect(c.message).toBe("模型接口返回 HTTP 401")
    const d = await fail(async () => ok({ error: { type: "含 空格 与 中文" } }, 500))
    expect(d.message).toBe("模型接口返回 HTTP 500")
  })

  it("200 但不是 JSON、或没有文本：message 里不带响应正文", async () => {
    const a = await fail(async init => ok(`<html>echo ${authOf(init)}</html>`))
    expect(a.message).toBe("模型接口返回的不是 JSON")
    const b = await fail(async init => ok({ choices: [], echo: authOf(init) }))
    expect(b.message).toBe("模型接口的响应里没有文本")
  })

  it("网络错误的异常信息里万一带着 key（fetch 实现各异）也被抹掉", async () => {
    const e = await fail(async (init) => {
      throw new Error(`connect ECONNREFUSED headers=${authOf(init)}`)
    })
    expect(e.message).toContain("ECONNREFUSED")
    expect(e.message).not.toContain(KEY)
    expect(e.message).toContain("***")
  })

  it("请求带 redirect: \"error\"", async () => {
    let seen: RequestInit | undefined
    await fail(async (init) => {
      seen = init
      return ok({ choices: [{ message: { content: "x" } }] })
    })
    expect(seen!.redirect).toBe("error")
  })

  it("真实的 307 重定向到另一个 origin：x-api-key 与 authorization 都没有送过去，调用失败且 message 无 key", async () => {
    const seen: { headers?: Record<string, unknown> } = {}
    const evil = http.createServer((req, res) => {
      seen.headers = { "x-api-key": req.headers["x-api-key"], "authorization": req.headers.authorization }
      res.end("{}")
    })
    await new Promise<void>(r => evil.listen(0, "127.0.0.1", r))
    const evilPort = (evil.address() as AddressInfo).port
    const good = http.createServer((_req, res) => {
      res.statusCode = 307
      res.setHeader("location", `http://127.0.0.1:${evilPort}/x`)
      res.end()
    })
    await new Promise<void>(r => good.listen(0, "localhost", r))
    const goodPort = (good.address() as AddressInfo).port
    try {
      for (const provider of ["anthropic", "openai"] as const) {
        seen.headers = undefined
        const err = await createLlm({ provider, apiKey: KEY, model: "m", baseUrl: `http://localhost:${goodPort}` })({ user: "hi", maxTokens: 5 }).catch(e => e)
        expect(err, provider).toBeInstanceOf(LlmError)
        expect(err.message).not.toContain(KEY)
        expect(seen.headers, `${provider}：重定向目标不该收到任何请求`).toBeUndefined()
      }
    } finally {
      good.close()
      evil.close()
    }
  })
})

describe("s8：openai 兼容的输出 token 上限字段名可配置", () => {
  const env = { ENRICH_LLM_PROVIDER: "openai", ENRICH_LLM_API_KEY: "k", ENRICH_LLM_MODEL: "m" }
  const bodyOf = async (cfg: Parameters<typeof createLlm>[0]) => {
    let body: any
    await createLlm(cfg, (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      return ok({ choices: [{ message: { content: "x" } }], content: [{ type: "text", text: "x" }] })
    }) as unknown as typeof fetch)({ user: "u", maxTokens: 123 })
    return body
  }

  it("默认 max_tokens（保持现状）；设成 max_completion_tokens 后只发这个字段", async () => {
    const dflt = readTagLlm(env)!
    expect(dflt.maxTokensField).toBeUndefined()
    expect(await bodyOf(dflt)).toMatchObject({ max_tokens: 123 })
    const cfg = readTagLlm({ ...env, ENRICH_LLM_MAX_TOKENS_FIELD: "max_completion_tokens" })!
    const body = await bodyOf(cfg)
    expect(body.max_completion_tokens).toBe(123)
    expect(body).not.toHaveProperty("max_tokens")
  })

  it("不认识的值按默认并警告；anthropic 协议不受影响", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    try {
      expect(readTagLlm({ ...env, ENRICH_LLM_MAX_TOKENS_FIELD: "max_output" })!.maxTokensField).toBeUndefined()
      expect(String(warn.mock.calls[0][0])).toContain("max_output")
    } finally {
      warn.mockRestore()
    }
    const a = readTagLlm({ ...env, ENRICH_LLM_PROVIDER: "anthropic", ENRICH_LLM_MAX_TOKENS_FIELD: "max_completion_tokens" })!
    expect(await bodyOf(a)).toMatchObject({ max_tokens: 123 })
  })

  it("深读沿用标注层的写法；深读换了模型就不沿用", () => {
    const base = { ...env, ENRICH_LLM_MAX_TOKENS_FIELD: "max_completion_tokens" }
    expect(readDeepLlm(base)!.maxTokensField).toBe("max_completion_tokens")
    expect(readDeepLlm({ ...base, ENRICH_DEEP_LLM_MODEL: "other" })!.maxTokensField).toBeUndefined()
    expect(readDeepLlm({ ...base, ENRICH_DEEP_LLM_MODEL: "other", ENRICH_DEEP_LLM_MAX_TOKENS_FIELD: "max_completion_tokens" })!.maxTokensField).toBe("max_completion_tokens")
  })
})
