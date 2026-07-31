import * as v from 'valibot'
import { createInstanceSchema } from '#shared/schemas/groups'
import { addInstance } from '#server/utils/store'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event)
  const res = v.safeParse(createInstanceSchema, body)
  if (!res.success) {
    throw createError({
      statusCode: 400,
      message: res.issues[0]?.message || '请求参数校验失败',
    })
  }
  return await addInstance(id, res.output)
})
