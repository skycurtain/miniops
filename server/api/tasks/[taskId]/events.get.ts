import { subscribe, getTaskState } from '#server/utils/task-manager'
import { createSSEStream } from '#server/utils/sse'
import type { TaskEvent } from '#shared/schemas/task'

/**
 * GET /api/tasks/:taskId/events
 * SSE 订阅任务进度。
 *
 * 任务执行与 SSE 连接解绑：断线不中断任务，重连可恢复。
 */
export default defineEventHandler((event) => {
  const taskId = getRouterParam(event, 'taskId')!
  const taskState = getTaskState(taskId)

  if (!taskState) {
    throw createError({ statusCode: 404, message: '任务不存在或已过期' })
  }

  const sse = createSSEStream(event)

  // 订阅任务事件
  const unsubscribe = subscribe(taskId, (taskEvent: TaskEvent) => {
    void sse.send(taskEvent.data, taskEvent.event)
  })

  // 连接关闭时取消订阅
  event.node.req.on('close', () => {
    unsubscribe()
    void sse.close()
  })

  // 如果任务已是终态，推送 final 事件后关闭
  if (taskState.status === 'done' || taskState.status === 'cancelled' || taskState.status === 'failed') {
    const summary = taskState.summary || { total: 0, success: 0, failed: 0, skipped: 0 }
    const finalEvent = taskState.status === 'done'
      ? { event: 'complete', data: { taskId, summary } }
      : taskState.status === 'cancelled'
        ? { event: 'cancelled', data: { taskId, summary } }
        : { event: 'error', data: { taskId, message: '任务执行失败' } }
    void sse.send(finalEvent.data, finalEvent.event).then(() => sse.close())
  }

  return sse.response
})
