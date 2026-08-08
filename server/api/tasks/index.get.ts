import { listTasks, getActiveTasks } from '#server/utils/task-manager'
import type { TaskStatus } from '#shared/schemas/task'

/**
 * GET /api/tasks
 * 任务列表（任务查看器用）。
 *
 * Query:
 *   status: 逗号分隔的状态过滤，如 "done,failed,cancelled"
 *   active: 1 = 返回活跃任务（执行中 + 排队中），忽略 status
 *   limit:  默认 10
 */
export default defineEventHandler((event) => {
  const query = getQuery(event)

  if (query.active) {
    return getActiveTasks()
  }

  const statusParam = query.status as string | undefined
  const statuses = statusParam
    ? (statusParam.split(',').filter(Boolean) as TaskStatus[])
    : undefined
  const limit = Number(query.limit) || 10

  return listTasks(statuses, limit)
})
