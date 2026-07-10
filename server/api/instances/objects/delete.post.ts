import { getGroups } from '../../../utils/store'
import { deleteObjects, deleteByPrefixes } from '../../../utils/minio'
import type { MinioInstance } from '../../../types'

/**
 * POST /api/instances/objects/delete
 * 批量删除对象，支持递归删除文件夹。
 *
 * 请求体: { instanceId, bucket, keys: string[], prefixes?: string[] }
 *   - keys:     要删除的对象 key 列表
 *   - prefixes: 要递归删除的文件夹前缀列表（如 ["sub-folder/"]）
 *
 * 响应: DeleteObjectsResult { deleted, errors }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    keys: string[]
    prefixes?: string[]
  }>(event)

  if (!body?.instanceId) {
    throw createError({ statusCode: 400, statusMessage: '缺少 instanceId' })
  }
  if (!body?.bucket) {
    throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  }
  if (!body?.keys?.length && !body?.prefixes?.length) {
    throw createError({ statusCode: 400, statusMessage: '缺少 keys 或 prefixes' })
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

  // 合并结果
  const allDeleted: string[] = []
  const allErrors: { key: string, error: string }[] = []

  // 1. 删除普通对象
  if (body.keys?.length) {
    const result = await deleteObjects(instance, body.bucket, body.keys)
    allDeleted.push(...result.deleted)
    allErrors.push(...result.errors)
  }

  // 2. 递归删除文件夹
  if (body.prefixes?.length) {
    const result = await deleteByPrefixes(instance, body.bucket, body.prefixes)
    allDeleted.push(...result.deleted)
    allErrors.push(...result.errors)
  }

  // 全部失败时返回 502，部分失败时正常返回结果（前端按 errors 处理）
  if (allErrors.length && allDeleted.length === 0) {
    throw createError({
      statusCode: 502,
      statusMessage: allErrors[0]?.error || '删除失败',
    })
  }
  return { deleted: allDeleted, errors: allErrors }
})
