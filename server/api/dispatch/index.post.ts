import { getGroups } from '../../utils/store'
import { registerTask, executeDispatch } from '../../utils/dispatcher'
import { getStoredFile } from '../../utils/uploads'
import { sanitizeObjectKey } from '../../utils/minio'
import type { DispatchRequest, DispatchTask, MinioInstance, StoredFile } from '../../types'

/**
 * POST /api/dispatch
 * 提交分发任务。后端立即创建任务并返回 taskId，后台异步执行。
 *
 * 请求体: DispatchRequest
 * 响应: 202 Accepted { taskId: "task-xxx" }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<DispatchRequest>(event)

  // 基本校验
  if (!body?.files?.length) {
    throw createError({ statusCode: 400, statusMessage: '至少选择一个文件' })
  }
  if (!body.groupIds?.length && !body.instanceIds?.length) {
    throw createError({ statusCode: 400, statusMessage: '至少选择一个目标实例组或实例' })
  }

  // 获取所有组，展开 groupIds + instanceIds 为实例列表（去重，仅 enabled）
  const allGroups = await getGroups()
  const resolvedMap = new Map<string, MinioInstance>()

  // 展开 groupIds
  for (const g of allGroups) {
    if (body.groupIds.includes(g.id)) {
      for (const inst of g.instances) {
        if (inst.enabled) resolvedMap.set(inst.id, inst)
      }
    }
  }

  // 展开 instanceIds（跨组查找）
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

  // 解析 fileId → StoredFile
  const resolvedFiles: StoredFile[] = []
  for (const f of body.files) {
    const stored = getStoredFile(f.id)
    if (!stored) {
      throw createError({ statusCode: 400, statusMessage: `文件 ${f.id} 不存在或已过期` })
    }
    // 允许请求体覆盖 objectKey（例如前端调整目标路径）
    resolvedFiles.push(f.objectKey ? { ...stored, objectKey: sanitizeObjectKey(f.objectKey) } : stored)
  }

  // 创建任务
  const task: DispatchTask = {
    id: `task-${crypto.randomUUID()}`,
    request: body,
    status: 'pending',
    resolvedInstances: Array.from(resolvedMap.values()),
    resolvedFiles,
    results: [],
    createdAt: new Date().toISOString(),
  }

  registerTask(task)

  // 后台异步执行（不 await，立即返回 taskId）
  executeDispatch(task).catch((e) => {
    console.error(`[dispatch] 任务 ${task.id} 执行异常:`, e)
  })

  setResponseStatus(event, 202)
  return { taskId: task.id }
})
