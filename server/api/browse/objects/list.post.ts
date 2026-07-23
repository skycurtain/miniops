import { getGroups } from '#server/utils/store'
import { listObjects, sanitizeObjectKey } from '#server/utils/minio'
import type { MinioInstance } from '#shared/schemas/groups'

/**
 * POST /api/browse/objects/list
 * 列出指定实例 bucket 下的对象和公共前缀（虚拟文件夹）。
 *
 * 请求体: { instanceId, bucket, prefix?, continuationToken? }
 * 响应: ListObjectsResult
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    prefix?: string
    continuationToken?: string
  }>(event)

  if (!body?.instanceId) {
    throw createError({ statusCode: 400, statusMessage: '缺少 instanceId' })
  }
  if (!body?.bucket) {
    throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  }

  // 从 store 查出实例
  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find((i) => i.id === body.instanceId)
    if (instance) break
  }
  if (!instance) {
    throw createError({ statusCode: 404, statusMessage: '未找到指定实例' })
  }

  // 清洗 prefix，防路径遍历；非空时补回尾部斜杠（S3 虚拟文件夹模式要求）
  let prefix = body.prefix ? sanitizeObjectKey(body.prefix) : ''
  if (prefix && !prefix.endsWith('/')) prefix += '/'

  const result = await listObjects(instance, body.bucket, prefix, '/', body.continuationToken)

  if (result.error) {
    throw createError({ statusCode: 502, statusMessage: result.error })
  }
  return result
})
