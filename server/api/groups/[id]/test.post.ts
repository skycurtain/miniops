import { getGroup } from '../../../utils/store'
import { testGroupConnectivity, testConnectivity } from '../../../utils/minio'

/**
 * POST /api/groups/:id/test
 * 测试组内所有实例的连通性。
 * 支持 query 参数 ?instanceId=xxx 只测单个实例。
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少组 id' })

  const group = await getGroup(id)
  if (!group) throw createError({ statusCode: 404, statusMessage: '实例组不存在' })

  // 单实例测试
  const instanceId = getQuery(event).instanceId as string | undefined
  if (instanceId) {
    const inst = group.instances.find(i => i.id === instanceId)
    if (!inst) throw createError({ statusCode: 404, statusMessage: '实例不存在' })
    return [await testConnectivity(inst)]
  }

  // 全组测试
  return await testGroupConnectivity(group.instances)
})
