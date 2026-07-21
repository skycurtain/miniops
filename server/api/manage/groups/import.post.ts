import * as v from 'valibot'
import { instanceGroupSchema } from '#shared/schemas/groups'
import { importGroups } from '#server/utils/store'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const res = v.safeParse(v.array(instanceGroupSchema), body)
  if (!res.success) {
    throw createError({
      statusCode: 400,
      statusMessage: res.issues[0]?.message || '导入数据格式错误',
    })
  }
  return await importGroups(res.output)
})
