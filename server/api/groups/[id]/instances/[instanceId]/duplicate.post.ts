import { duplicateInstance } from '../../../../../utils/store'

/** POST /api/groups/:id/instances/:instanceId/duplicate — 复制实例 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const instanceId = getRouterParam(event, 'instanceId')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少组 id' })
  if (!instanceId) throw createError({ statusCode: 400, statusMessage: '缺少实例 id' })

  return await duplicateInstance(id, instanceId)
})
