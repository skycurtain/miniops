import { getGroups } from '../../../utils/store'
import { listObjects, sanitizeObjectKey } from '../../../utils/minio'
import type { MinioInstance } from '../../../types'

/**
 * POST /api/instances/objects/list
 * 列出指定实例 bucket 下的对象和公共前缀（虚拟文件夹）。
 *
 * 请求体: { instanceId, bucket, prefix?, delimiter?, continuationToken? }
 * 响应: ListObjectsResult
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    prefix?: string
    delimiter?: string
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
    instance = g.instances.find(i => i.id === body.instanceId)
    if (instance) break
  }
  if (!instance) {
    throw createError({ statusCode: 404, statusMessage: '未找到指定实例' })
  }

  // 清洗 prefix，防路径遍历
  const prefix = body.prefix ? sanitizeObjectKey(body.prefix) : ''
  // 确保 prefix 以 / 结尾（S3 习惯，非强制），如果不以 / 结尾且非空，补一个
  // 注意：只在不为空且不以 / 结尾时补，避免破坏用户精确前缀
  const normalizedPrefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix

  const result = await listObjects(
    instance,
    body.bucket,
    normalizedPrefix,
    body.delimiter ?? '/',
    body.continuationToken,
  )

  if (result.error) {
    throw createError({ statusCode: 502, statusMessage: result.error })
  }
  return result
})
