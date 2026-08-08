import { getTaskState } from '#server/utils/task-manager'

/**
 * GET /api/tasks/:taskId/state
 * 查询任务状态快照（重连恢复用）。
 */
export default defineEventHandler((event) => {
  const taskId = getRouterParam(event, 'taskId')!
  const state = getTaskState(taskId)
  if (!state) {
    throw createError({ statusCode: 404, message: '任务不存在或已过期' })
  }
  return state
})
