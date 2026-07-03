import { deleteInstance } from '../../../../utils/store'

/** DELETE /api/groups/:id/instances/:instanceId — 删除组内实例 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const instanceId = getRouterParam(event, 'instanceId')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少组 id' })
  if (!instanceId) throw createError({ statusCode: 400, statusMessage: '缺少实例 id' })

  await deleteInstance(id, instanceId)
  setResponseStatus(event, 204)
  return null
})
