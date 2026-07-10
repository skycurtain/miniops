import { getGroups } from '../../../utils/store'
import { presignGetUrl } from '../../../utils/minio'
import type { MinioInstance } from '../../../types'

/**
 * POST /api/instances/objects/presign
 * 生成预签名 GET URL（下载用）。
 *
 * 请求体: { instanceId, bucket, key, expiresIn? }
 * 响应: { url: string }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    key: string
    expiresIn?: number
  }>(event)

  if (!body?.instanceId) {
    throw createError({ statusCode: 400, statusMessage: '缺少 instanceId' })
  }
  if (!body?.bucket) {
    throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  }
  if (!body?.key) {
    throw createError({ statusCode: 400, statusMessage: '缺少 key' })
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

  // 限制有效期上限，避免过长（默认 15 分钟，最长 1 小时）
  const expiresIn = Math.min(body.expiresIn ?? 900, 3600)

  const url = presignGetUrl({
    endpoint: instance.endpoint,
    bucket: body.bucket,
    objectKey: body.key,
    accessKey: instance.accessKey,
    secretKey: instance.secretKey,
    region: 'us-east-1',
    expiresIn,
  })

  return { url }
})
