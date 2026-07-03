import { getGroups } from '../../utils/store'
import { listBucketsBatch } from '../../utils/minio'
import type { MinioInstance } from '../../types'

/**
 * POST /api/instances/buckets
 * 批量获取实例的 bucket 列表（从 MinIO ListBuckets API 实时拉取）。
 *
 * 请求体: { instanceIds: string[] }
 * 响应: { [instanceId]: { buckets: string[], error?: string } }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ instanceIds: string[] }>(event)
  if (!body?.instanceIds?.length) {
    throw createError({ statusCode: 400, statusMessage: '缺少 instanceIds' })
  }

  // 从 store 查出实例
  const allGroups = await getGroups()
  const targetInstances: MinioInstance[] = []
  for (const g of allGroups) {
    for (const inst of g.instances) {
      if (body.instanceIds.includes(inst.id)) {
        targetInstances.push(inst)
      }
    }
  }

  if (!targetInstances.length) {
    throw createError({ statusCode: 404, statusMessage: '未找到指定实例' })
  }

  // 批量请求 bucket 列表
  const results = await listBucketsBatch(targetInstances)

  // 转为 { [instanceId]: { buckets, error? } }
  const output: Record<string, { buckets: string[], error?: string }> = {}
  for (const r of results) {
    output[r.instanceId] = { buckets: r.buckets, error: r.error }
  }
  return output
})
