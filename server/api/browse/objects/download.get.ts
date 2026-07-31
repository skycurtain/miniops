import { getGroups } from '#server/utils/store'
import { getObjectStream } from '#server/utils/minio'
import { sendStream } from 'h3'
import type { MinioInstance } from '#shared/schemas/groups'

/**
 * GET /api/browse/objects/download?instanceId=&bucket=&key=&inline=1
 * 流式下载对象，后端代理转发给浏览器。
 *
 * inline=1 时 Content-Disposition: inline（预览）；
 * 否则 Content-Disposition: attachment（下载）。
 *
 * 支持 HTTP Range 请求头透传（视频预览）。
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const instanceId = query.instanceId as string
  const bucket = query.bucket as string
  const key = query.key as string
  const inline = query.inline === '1' || query.inline === 'true'

  if (!instanceId) {
    throw createError({ statusCode: 400, message: '缺少 instanceId' })
  }
  if (!bucket) {
    throw createError({ statusCode: 400, message: '缺少 bucket' })
  }
  if (!key) {
    throw createError({ statusCode: 400, message: '缺少 key' })
  }

  // 从 store 查出实例
  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find((i) => i.id === instanceId)
    if (instance) break
  }
  if (!instance) {
    throw createError({ statusCode: 404, message: '未找到指定实例' })
  }

  // 读取浏览器的 Range 请求头
  const rangeHeader = getRequestHeader(event, 'range') || undefined

  const { stream, metadata, error } = await getObjectStream(instance, bucket, key, rangeHeader)
  if (error || !stream || !metadata) {
    throw createError({ statusCode: 502, message: error || '下载失败' })
  }

  // 文件名取 key 最后一段
  const filename = key.split('/').pop() || 'download'
  setResponseHeader(event, 'Content-Type', metadata.contentType)
  if (inline) {
    setResponseHeader(
      event,
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(filename)}"`,
    )
  } else {
    setResponseHeader(
      event,
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    )
  }
  if (metadata.contentLength) {
    setResponseHeader(event, 'Content-Length', metadata.contentLength)
  }
  if (metadata.etag) {
    setResponseHeader(event, 'ETag', metadata.etag)
  }
  if (metadata.lastModified) {
    setResponseHeader(event, 'Last-Modified', metadata.lastModified)
  }
  // 声明支持 Range 请求（视频预览、断点续传依赖）
  setResponseHeader(event, 'Accept-Ranges', 'bytes')
  // Range 请求返回 206
  if (metadata.statusCode === 206) {
    setResponseStatus(event, 206)
    if (metadata.contentRange) {
      setResponseHeader(event, 'Content-Range', metadata.contentRange)
    }
  }

  // 清理：流结束后释放资源
  event.node.res.on('close', () => {
    stream.destroy()
  })
  event.node.res.on('error', () => {
    stream.destroy()
  })

  return sendStream(event, stream)
})
