import { subscribeSyncTask } from '../../utils/sync'

/**
 * GET /api/sync/events?taskId=xxx
 * SSE 流，实时推送同步进度。
 *
 * 事件格式:
 *   event: scan-progress  data: {"type":"scan-progress","taskId":"...","scannedCount":N}
 *   event: scan-complete  data: {"type":"scan-complete","taskId":"...","files":[...],"totalCount":N,"totalSize":N}
 *   event: start          data: {"type":"start","taskId":"..."}
 *   event: progress       data: {"type":"progress","taskId":"...","result":{...}}
 *   event: complete       data: {"type":"complete","taskId":"...","summary":{...}}
 */
export default defineEventHandler(async (event) => {
  const taskId = getQuery(event).taskId as string | undefined
  if (!taskId) {
    throw createError({ statusCode: 400, statusMessage: '缺少 taskId 参数' })
  }

  const stream = createEventStream(event)

  // 订阅任务事件，推送到 SSE
  const unsubscribe = subscribeSyncTask(taskId, (evt) => {
    stream.push({
      event: evt.type,
      data: JSON.stringify(evt),
    }).catch(() => {
      // 推送失败（连接已关闭），忽略
    })

    // complete 事件推送后关闭流
    if (evt.type === 'complete') {
      stream.close().catch(() => {})
    }
  })

  // 连接关闭时清理订阅
  stream.onClosed(() => {
    unsubscribe()
  })

  return stream.send()
})
