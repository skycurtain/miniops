import { addInstance } from '../../../utils/store'
import { assertEndpoint, assertNonEmpty } from '../../../utils/validate'
import type { CreateInstanceInput } from '../../../types'

/** POST /api/groups/:id/instances — 组内新增实例 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少组 id' })

  const body = await readBody<Partial<CreateInstanceInput>>(event)
  assertNonEmpty(body?.name, '实例名称')
  const endpoint = body?.endpoint
  assertNonEmpty(endpoint, 'endpoint')
  assertEndpoint(endpoint!)
  assertNonEmpty(body?.accessKey, 'accessKey')
  assertNonEmpty(body?.secretKey, 'secretKey')

  return await addInstance(id, {
    name: body!.name!.trim(),
    endpoint: body!.endpoint!.trim(),
    accessKey: body!.accessKey!.trim(),
    secretKey: body!.secretKey!.trim(),
    enabled: body!.enabled ?? true,
  })
})
