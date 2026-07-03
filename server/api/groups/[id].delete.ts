import { deleteGroup } from '../../utils/store'

/** DELETE /api/groups/:id — 删除实例组（内置默认组不可删） */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 id' })
  await deleteGroup(id)
  setResponseStatus(event, 204)
  return null
})
