import { getGroups } from '#server/utils/store'
import { listBucketsWithMeta } from '#server/utils/s3'
import type { S3Instance } from '#shared/schemas/groups'

/**
 * GET /api/browse/buckets?instanceId=xxx
 * 获取指定实例的 bucket 列表（含创建时间）。
 *
 * 响应: { buckets: BucketInfo[], error?: string }
 */
export default defineEventHandler(async (event) => {
  const instanceId = getQuery(event).instanceId as string | undefined
  if (!instanceId) {
    throw createError({ statusCode: 400, message: '缺少 instanceId' })
  }

  // 从 store 查出实例
  const allGroups = await getGroups()
  let instance: S3Instance | undefined
  for (const g of allGroups) {
    instance = g.instances.find((i) => i.id === instanceId)
    if (instance) break
  }
  if (!instance) {
    throw createError({ statusCode: 404, message: '未找到指定实例' })
  }

  return await listBucketsWithMeta(instance)
})
