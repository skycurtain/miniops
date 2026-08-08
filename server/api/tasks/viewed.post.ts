import { markViewed } from '#server/utils/task-manager'

/**
 * POST /api/tasks/viewed
 * 批量标记已查看（角标用）。
 *
 * Body: { taskIds: string[] }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ taskIds: string[] }>(event)
  if (!body?.taskIds || !Array.isArray(body.taskIds)) {
    throw createError({ statusCode: 400, message: '缺少 taskIds' })
  }
  markViewed(body.taskIds)
  return { success: true }
})
