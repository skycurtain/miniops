import { getGroups } from '#server/utils/store'
import {
  copyObjectStream,
  collectObjectsByPrefixes,
  inferContentType,
} from '#server/utils/minio'
import { createSSEStream } from '#server/utils/sse'
import type { MinioInstance } from '#shared/schemas/groups'

/**
 * POST /api/browse/objects/copy
 * 复制对象到另一个实例/bucket（流式 GetObject -> PutObject，不落盘）。
 *
 * 请求体: CopyMoveRequest
 * 响应: SSE 流，推送扫描/传输/完成进度事件。
 *
 * 事件类型:
 *   - scan: { scanned: number }  扫描进度
 *   - total: { total: number }  扫描完成，总数
 *   - progress: { key, status, progress }  单文件进度
 *   - done: { success, failed }  完成
 *   - error: { message }  错误
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    sourceInstanceId: string
    sourceBucket: string
    sourcePrefix: string
    keys: string[]
    prefixes: string[]
    targetInstanceId: string
    targetBucket: string
    targetPrefix: string
  }>(event)

  if (!body?.sourceInstanceId || !body?.targetInstanceId) {
    throw createError({ statusCode: 400, statusMessage: '缺少源/目标实例 ID' })
  }
  if (!body?.sourceBucket || !body?.targetBucket) {
    throw createError({ statusCode: 400, statusMessage: '缺少源/目标 bucket' })
  }

  const allGroups = await getGroups()
  const findInstance = (id: string): MinioInstance | undefined => {
    for (const g of allGroups) {
      const inst = g.instances.find((i) => i.id === id)
      if (inst) return inst
    }
    return undefined
  }

  const sourceInstance = findInstance(body.sourceInstanceId)
  const targetInstance = findInstance(body.targetInstanceId)
  if (!sourceInstance) {
    throw createError({ statusCode: 404, statusMessage: '未找到源实例' })
  }
  if (!targetInstance) {
    throw createError({ statusCode: 404, statusMessage: '未找到目标实例' })
  }

  const sse = createSSEStream(event)

  // 异步执行复制，不阻塞响应
  ;(async () => {
    try {
      // 1. 收集所有要复制的对象 key
      const allKeys = new Set<string>(body.keys)
      for (const prefix of body.prefixes) {
        const { keys, error } = await collectObjectsByPrefixes(sourceInstance, body.sourceBucket, [
          prefix,
        ])
        if (error) {
          await sse.send({ message: error }, 'error')
          await sse.close()
          return
        }
        for (const k of keys) allKeys.add(k)
      }

      // 单独对象也要收集大小信息
      const keyArray = Array.from(allKeys)
      await sse.send({ total: keyArray.length }, 'total')

      // 2. 逐个复制
      let success = 0
      let failed = 0
      for (const key of keyArray) {
        await sse.send({ key }, 'start')
        try {
          // 计算目标 key：源前缀剥离后拼接到目标前缀下
          const relativeKey =
            body.sourcePrefix && key.startsWith(body.sourcePrefix)
              ? key.slice(body.sourcePrefix.length)
              : key
          const targetKey = body.targetPrefix
            ? `${body.targetPrefix.replace(/\/$/, '')}/${relativeKey}`
            : relativeKey

          const contentType = inferContentType(key)
          await copyObjectStream(
            sourceInstance,
            body.sourceBucket,
            key,
            targetInstance,
            body.targetBucket,
            targetKey,
            contentType,
          )
          success++
          await sse.send({ key, status: 'success' }, 'progress')
        } catch (e: unknown) {
          const err = e as { message?: string }
          failed++
          await sse.send({ key, status: 'failed', error: err?.message || '复制失败' }, 'progress')
        }
      }

      // 3. 完成
      await sse.send({ success, failed }, 'done')
    } catch (e: unknown) {
      const err = e as { message?: string }
      await sse.send({ message: err?.message || '复制过程中出错' }, 'error')
    } finally {
      await sse.close()
    }
  })()

  return sse.response
})
