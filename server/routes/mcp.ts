import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { toWebRequest } from "h3"
import { getActions } from "#/actions/runtime"
import { getFeed } from "#/feed/runtime"
import { createMcpServer } from "#/mcp/tools"
import { guarded } from "#/registry/http"
import { InputError } from "#/registry/spec"

/**
 * MCP 入口（Streamable HTTP，无状态）：POST /mcp，工具见 server/mcp/tools.ts。
 *
 * 访问控制与用户源接口完全一致（registry/http.ts 的 checkAccess：只给本机 + Host/Origin/Sec-Fetch-Site 检查
 * + 写请求只收 application/json；非本机用 USER_SOURCES_TOKEN 的 Bearer 令牌）。
 * 调用方名取自请求头 X-Actor（可空，ASCII），写进审计，用来区分是哪个 agent。
 *
 * 无状态：每个请求一个 McpServer 与传输，不保留会话、不开 SSE 长连接，所以也没有 GET（服务器主动推送）与 DELETE（结束会话），回 405。
 * 要看实时新闻流请用 GET /api/feed/stream；agent 靠 query_feed 的 since 与 cursor 轮询。
 */
export default defineEventHandler(event => guarded(event, async () => {
  if (event.method !== "POST") {
    setResponseHeader(event, "Allow", "POST")
    throw new InputError("MCP 入口只接受 POST（无状态）", 405)
  }
  const server = createMcpServer({
    feed: (await getFeed()).service,
    actions: await getActions(),
    caller: { entry: "mcp", actor: getHeader(event, "x-actor") },
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(toWebRequest(event))
  } finally {
    await transport.close()
    await server.close()
  }
}))
