import * as v from 'valibot'
import { createGroupSchema } from '#shared/schemas/groups'
import { createGroup } from '#server/utils/store'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const res = v.safeParse(createGroupSchema, body)
  if (!res.success) {
    throw createError({
      statusCode: 400,
      message: res.issues[0]?.message || '请求参数校验失败',
    })
  }
  return await createGroup(res.output)
})
