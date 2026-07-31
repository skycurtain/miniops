import { getGroups } from '#server/utils/store'
import { collectObjectsByPrefixes } from '#server/utils/minio'
import type { MinioInstance } from '#shared/schemas/groups'

/**
 * POST /api/browse/objects/delete/preview
 * 预览将要删除的对象列表（递归展开文件夹），不执行删除。
 *
 * 请求体: { instanceId, bucket, keys: string[], prefixes?: string[] }
 * 响应: { items: { key, name }[], total: number }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    keys: string[]
    prefixes?: string[]
  }>(event)

  if (!body?.instanceId) {
    throw createError({ statusCode: 400, message: '缺少 instanceId' })
  }
  if (!body?.bucket) {
    throw createError({ statusCode: 400, message: '缺少 bucket' })
  }
  if (!body?.keys?.length && !body?.prefixes?.length) {
    throw createError({ statusCode: 400, message: '缺少 keys 或 prefixes' })
  }

  // 从 store 查出实例
  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find((i) => i.id === body.instanceId)
    if (instance) break
  }
  if (!instance) {
    throw createError({ statusCode: 404, message: '未找到指定实例' })
  }

  // 收集全部 key（不设上限）
  const allKeys = new Set<string>(body.keys)

  if (body.prefixes?.length) {
    const { keys, error } = await collectObjectsByPrefixes(instance, body.bucket, body.prefixes, 0)
    if (error) {
      throw createError({ statusCode: 502, message: error })
    }
    for (const k of keys) allKeys.add(k)
  }

  const items = Array.from(allKeys).map((key) => ({
    key,
    name: key.split('/').pop() ?? key,
  }))

  return { items, total: items.length }
})
