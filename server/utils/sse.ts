import type { H3Event } from 'h3'
import { createEventStream } from 'h3'

/**
 * 创建 SSE 事件流，设置正确的响应头。
 *
 * 返回一个 send 函数，用于向客户端推送事件。
 */
export function createSSEStream(event: H3Event) {
  const stream = createEventStream(event)
  return {
    /** 推送一个事件 */
    async send(data: unknown, eventName?: string) {
      await stream.push({
        data: JSON.stringify(data),
        event: eventName,
      })
    },
    /** 关闭流 */
    async close() {
      await stream.close()
    },
    /** 返回给 h3 的响应 */
    response: stream.send(),
  }
}
