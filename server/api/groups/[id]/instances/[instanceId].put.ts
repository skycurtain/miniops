import { updateInstance } from '../../../../utils/store'
import { assertEndpoint, assertNonEmpty } from '../../../../utils/validate'
import type { UpdateInstanceInput } from '../../../../types'

/** PUT /api/groups/:id/instances/:instanceId — 更新组内实例 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const instanceId = getRouterParam(event, 'instanceId')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少组 id' })
  if (!instanceId) throw createError({ statusCode: 400, statusMessage: '缺少实例 id' })

  const body = await readBody<UpdateInstanceInput>(event)
  // 仅校验显式传入的字段
  if (body?.name !== undefined) assertNonEmpty(body.name, '实例名称')
  if (body?.endpoint !== undefined) {
    assertNonEmpty(body.endpoint, 'endpoint')
    assertEndpoint(body.endpoint.trim())
  }
  if (body?.accessKey !== undefined) assertNonEmpty(body.accessKey, 'accessKey')
  if (body?.secretKey !== undefined) assertNonEmpty(body.secretKey, 'secretKey')

  return await updateInstance(id, instanceId, {
    name: body?.name?.trim(),
    endpoint: body?.endpoint?.trim(),
    accessKey: body?.accessKey?.trim(),
    secretKey: body?.secretKey?.trim(),
    enabled: body?.enabled,
  })
})
