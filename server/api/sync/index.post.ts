import { getGroups } from '../../utils/store'
import { registerSyncTask, executeSync } from '../../utils/sync'
import type { SyncRequest, SyncTask, MinioInstance } from '../../types'

/**
 * POST /api/sync
 * 提交实例间同步任务。后端立即创建任务并返回 taskId，后台异步执行。
 *
 * 请求体: SyncRequest
 * 响应: 202 Accepted { taskId: "sync-xxx" }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<SyncRequest>(event)

  // 基本校验
  if (!body?.source?.instanceId) {
    throw createError({ statusCode: 400, statusMessage: '缺少源实例' })
  }
  if (!body?.source?.bucket) {
    throw createError({ statusCode: 400, statusMessage: '缺少源 bucket' })
  }
  if (!body?.source?.keys?.length && !body?.source?.prefixes?.length) {
    throw createError({ statusCode: 400, statusMessage: '未选择源对象' })
  }
  if (!body?.targets?.instanceIds?.length) {
    throw createError({ statusCode: 400, statusMessage: '未选择目标实例' })
  }

  // 展开目标实例 + 查找源实例（遍历 groups）
  const allGroups = await getGroups()
  const resolvedMap = new Map<string, MinioInstance>()
  let sourceInstance: MinioInstance | null = null

  for (const g of allGroups) {
    for (const inst of g.instances) {
      // 查找源实例
      if (inst.id === body.source.instanceId) {
        sourceInstance = inst
      }
      // 展开目标实例（仅 enabled）
      if (body.targets.instanceIds.includes(inst.id) && inst.enabled) {
        resolvedMap.set(inst.id, inst)
      }
    }
  }

  if (!sourceInstance) {
    throw createError({ statusCode: 404, statusMessage: '源实例不存在' })
  }
  if (resolvedMap.size === 0) {
    throw createError({ statusCode: 400, statusMessage: '选中的目标没有启用的实例' })
  }

  // 校验源不在目标中
  if (body.targets.instanceIds.includes(body.source.instanceId)) {
    throw createError({ statusCode: 400, statusMessage: '源实例不能作为同步目标' })
  }

  // 校验所有目标实例有 bucket
  for (const inst of resolvedMap.values()) {
    if (!body.targets.instanceBuckets[inst.id]) {
      throw createError({ statusCode: 400, statusMessage: '实例 ' + inst.name + ' 未指定 bucket' })
    }
  }

  // 创建任务
  const task: SyncTask = {
    id: 'sync-' + crypto.randomUUID(),
    request: body,
    status: 'pending',
    resolvedInstances: Array.from(resolvedMap.values()),
    sourceInstance,
    resolvedFiles: [],
    results: [],
    createdAt: new Date().toISOString(),
  }

  registerSyncTask(task)

  // 后台异步执行（不 await，立即返回 taskId）
  executeSync(task.id).catch((e) => {
    console.error('[sync] 任务 ' + task.id + ' 执行异常:', e)
  })

  setResponseStatus(event, 202)
  return { taskId: task.id }
})
