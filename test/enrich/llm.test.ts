import { describe, expect, it } from "vitest"
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
