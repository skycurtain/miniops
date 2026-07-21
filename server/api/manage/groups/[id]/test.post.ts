import { getGroup } from '#server/utils/store'
import { testGroupConnectivity } from '#server/utils/minio'
import type { ConnectivityResult } from '#shared/schemas/groups'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const group = await getGroup(id)
  if (!group) {
    throw createError({ statusCode: 404, statusMessage: '分组不存在' })
  }

  const instanceId = getQuery(event).instanceId as string | undefined

  let results: ConnectivityResult[]
  if (instanceId) {
    // 测试单个实例
    const instance = group.instances.find((i) => i.id === instanceId)
    if (!instance) {
      throw createError({ statusCode: 404, statusMessage: '实例不存在' })
    }
    const { testConnectivity } = await import('#server/utils/minio')
    results = [await testConnectivity(instance)]
  } else {
    // 测试组内所有 enabled 实例
    results = await testGroupConnectivity(group.instances)
  }

  return results
})
