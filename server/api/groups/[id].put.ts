import { updateGroup } from '../../utils/store'
import type { UpdateGroupInput } from '../../types'

/** PUT /api/groups/:id — 更新实例组信息（名称、描述） */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 id' })

  const body = await readBody<UpdateGroupInput>(event)
  if (body.name !== undefined && !body.name.trim()) {
    throw createError({ statusCode: 400, statusMessage: '组名称不能为空' })
  }
  return await updateGroup(id, {
    name: body.name?.trim(),
    description: body.description?.trim(),
  })
})
