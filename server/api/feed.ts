import { getObservationStore } from "#/collector"

/**
 * 时间流：所有源混在一起，从新到旧。
 * GET /api/feed?limit=50&source=cls-telegraph,jin10&cursor=<上一页的 nextCursor>&after=<毫秒>&before=<毫秒>
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const num = (name: string) => {
    const raw = query[name]
    if (raw === undefined || raw === "") return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) throw createError({ statusCode: 400, message: `Invalid ${name}` })
    return value
  }
  const source = typeof query.source === "string" ? query.source.split(",").map(s => s.trim()).filter(Boolean) : undefined
  const cursor = typeof query.cursor === "string" && query.cursor ? query.cursor : undefined
  const params = { limit: num("limit"), before: num("before"), after: num("after"), sources: source, cursor }

  const store = await getObservationStore()
  try {
    return await store.feed(params)
  } catch (e) {
    if (e instanceof Error && e.message === "Invalid cursor") throw createError({ statusCode: 400, message: e.message })
    logger.error(e)
    throw createError({ statusCode: 500, message: "Internal Server Error" })
  }
})
