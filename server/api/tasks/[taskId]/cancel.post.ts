import { cancelTask } from '#server/utils/task-manager'

/**
 * POST /api/tasks/:taskId/cancel
 * 取消任务。
 * - 排队中：从队列移除，直接从 Map 删除（不进入"最近完成"）
 * - 执行中：设置 cancelRequested，执行器在检查点停止
 */
export default defineEventHandler((event) => {
  const taskId = getRouterParam(event, 'taskId')!
  const success = cancelTask(taskId)
  if (!success) {
    throw createError({ statusCode: 404, message: '任务不存在或已完成' })
  }
  return { success: true }
})
