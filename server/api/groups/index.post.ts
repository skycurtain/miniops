import { createGroup } from '../../utils/store'
import type { CreateGroupInput } from '../../types'

/** POST /api/groups — 新增实例组 */
export default defineEventHandler(async (event) => {
  const body = await readBody<CreateGroupInput>(event)
  if (!body?.name || !body.name.trim()) {
    throw createError({ statusCode: 400, statusMessage: '组名称不能为空' })
  }
  return await createGroup({ name: body.name.trim(), description: body.description?.trim() })
})
