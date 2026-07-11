import { getGroups } from '../../utils/store'
import { registerCleanupTask, executeCleanup } from '../../utils/cleanup'
import type { CleanupRequest, CleanupTask, MinioInstance } from '../../types'

/**
 * POST /api/cleanup
 * 提交清理任务。后端立即创建任务并返回 taskId，后台异步执行。
 *
 * 请求体: CleanupRequest
 *   - instanceIds: 目标实例 ID 列表
 *   - bucket:      目标 bucket（所有实例共用）
 *   - prefix?:     前缀（留空 = bucket 根）
 *   - recursive?:  是否递归删除子前缀（无 keys/prefixes 时生效，默认 true）
 *   - keys?:       精确删除的对象 key 列表（来自预览勾选）
 *   - prefixes?:   精确递归删除的文件夹前缀列表（来自预览勾选）
 *
 * 响应: 202 Accepted { taskId: "cleanup-xxx" }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<CleanupRequest>(event)

  // 基本校验
  if (!body?.instanceIds?.length) {
    throw createError({ statusCode: 400, statusMessage: '至少选择一个目标实例' })
  }
  if (!body?.bucket) {
    throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  }

  // 按前缀全删模式：recursive 默认 true
  if (!body.keys?.length && !body.prefixes?.length) {
    if (body.recursive === undefined) body.recursive = true
  }

  // 从所有组中查找选中的实例（跨组查找，仅 enabled）
  const allGroups = await getGroups()
  const resolvedMap = new Map<string, MinioInstance>()
  for (const g of allGroups) {
    for (const inst of g.instances) {
      if (body.instanceIds.includes(inst.id) && inst.enabled) {
        resolvedMap.set(inst.id, inst)
      }
    }
  }
  if (resolvedMap.size === 0) {
    throw createError({ statusCode: 400, statusMessage: '选中的目标没有启用的实例' })
  }

  // 创建任务
  const task: CleanupTask = {
    id: `cleanup-${crypto.randomUUID()}`,
    request: body,
    status: 'pending',
    resolvedInstances: Array.from(resolvedMap.values()),
    results: [],
    createdAt: new Date().toISOString(),
  }

  registerCleanupTask(task)

  // 后台异步执行（不 await，立即返回 taskId）
  executeCleanup(task).catch((e) => {
    console.error(`[cleanup] 任务 ${task.id} 执行异常:`, e)
  })

  setResponseStatus(event, 202)
  return { taskId: task.id }
})
