import * as v from 'valibot'
import { updateInstanceSchema } from '#shared/schemas/groups'
import { updateInstance } from '#server/utils/store'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const instanceId = getRouterParam(event, 'instanceId')!
  const body = await readBody(event)
  const res = v.safeParse(updateInstanceSchema, body)
  if (!res.success) {
    throw createError({
      statusCode: 400,
      message: res.issues[0]?.message || '请求参数校验失败',
    })
  }
  const instance = await updateInstance(id, instanceId, res.output)
  if (!instance) {
    throw createError({ statusCode: 404, message: '实例不存在' })
  }
  return instance
})
