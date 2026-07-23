import { getGroups } from '#server/utils/store'
import {
  copyObjectStream,
  collectObjectsByPrefixes,
  deleteObjects,
  inferContentType,
} from '#server/utils/minio'
import { createSSEStream } from '#server/utils/sse'
import type { MinioInstance } from '#shared/schemas/groups'

/**
 * POST /api/browse/objects/move
 * 移动对象到另一个实例/bucket（复制 + 删除源对象）。
 *
 * 请求体: CopyMoveRequest（同 copy）
 * 响应: SSE 流，推送扫描/传输/删除源/完成进度事件。
 *
 * 事件类型:
 *   - scan: { scanned: number }  扫描进度
 *   - total: { total: number }  扫描完成，总数
 *   - progress: { key, status, progress }  单文件复制进度
 *   - deleting: {}  开始删除源对象
 *   - done: { success, failed, sourceDeleted, sourceDeleteFailed }  完成
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

  ;(async () => {
    try {
      // 1. 收集所有要移动的对象 key
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

      const keyArray = Array.from(allKeys)
      await sse.send({ total: keyArray.length }, 'total')

      // 2. 逐个复制
      const copiedKeys: string[] = []
      let success = 0
      let failed = 0
      for (const key of keyArray) {
        try {
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
          copiedKeys.push(key)
          success++
          await sse.send({ key, status: 'success' }, 'progress')
        } catch (e: unknown) {
          const err = e as { message?: string }
          failed++
          await sse.send({ key, status: 'failed', error: err?.message || '复制失败' }, 'progress')
        }
      }

      // 3. 删除源对象
      let sourceDeleted = 0
      let sourceDeleteFailed = 0
      if (copiedKeys.length > 0) {
        await sse.send({}, 'deleting')

        // 分批删除（每批 1000 个）
        for (let i = 0; i < copiedKeys.length; i += 1000) {
          const batch = copiedKeys.slice(i, i + 1000)
          const result = await deleteObjects(sourceInstance, body.sourceBucket, batch)
          sourceDeleted += result.deleted.length
          sourceDeleteFailed += result.errors.length
        }
      }

      // 4. 完成
      await sse.send({ success, failed, sourceDeleted, sourceDeleteFailed }, 'done')
    } catch (e: unknown) {
      const err = e as { message?: string }
      await sse.send({ message: err?.message || '移动过程中出错' }, 'error')
    } finally {
      await sse.close()
    }
  })()

  return sse.response
})
