import * as v from 'valibot'
import { updateGroupSchema } from '#shared/schemas/groups'
import { updateGroup } from '#server/utils/store'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event)
  const res = v.safeParse(updateGroupSchema, body)
  if (!res.success) {
    throw createError({
      statusCode: 400,
      message: res.issues[0]?.message || '请求参数校验失败',
    })
  }
  const group = await updateGroup(id, res.output)
  if (!group) {
    throw createError({ statusCode: 404, message: '分组不存在' })
  }
  return group
})
