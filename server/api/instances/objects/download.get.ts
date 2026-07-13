import { getGroups } from '../../../utils/store'
import { getObjectStream } from '../../../utils/minio'
import type { MinioInstance } from '../../../types'

/**
 * GET /api/instances/objects/download?instanceId=&bucket=&key=&inline=1
 * 流式下载对象，后端代理转发给浏览器。
 *
 * 后端签名 GET 对象 -> 拿到 MinIO 响应的 ReadableStream -> sendStream 转发。
 * 不缓冲整个文件到内存，支持大文件流式下载。
 *
 * inline=1 时 Content-Disposition: inline（浏览器内联渲染，用于预览）；
 * 否则 Content-Disposition: attachment（触发下载）。
 *
 * 支持 HTTP Range 请求：浏览器播放视频/音频时会发 Range: bytes=start-end，
 * 透传给 MinIO 并返回 206 Partial Content，避免只能播放开头一小段的问题。
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const instanceId = query.instanceId as string
  const bucket = query.bucket as string
  const key = query.key as string
  const inline = query.inline === '1' || query.inline === 'true'

  if (!instanceId) {
    throw createError({ statusCode: 400, statusMessage: '缺少 instanceId' })
  }
  if (!bucket) {
    throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  }
  if (!key) {
    throw createError({ statusCode: 400, statusMessage: '缺少 key' })
  }

  // 从 store 查出实例
  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find(i => i.id === instanceId)
    if (instance) break
  }
  if (!instance) {
    throw createError({ statusCode: 404, statusMessage: '未找到指定实例' })
  }

  // 读取浏览器的 Range 请求头（视频预览等场景浏览器会发 Range: bytes=start-end）
  const rangeHeader = getRequestHeader(event, 'range')

  const { response, error, cleanup } = await getObjectStream(instance, bucket, key, rangeHeader)
  if (error || !response) {
    throw createError({ statusCode: 502, statusMessage: error || '下载失败' })
  }

  // 透传响应头
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const contentLength = response.headers.get('content-length') ?? undefined
  const lastModified = response.headers.get('last-modified')
  const etag = response.headers.get('etag')
  const contentRange = response.headers.get('content-range')
  const acceptRanges = response.headers.get('accept-ranges')

  // 文件名取 key 最后一段
  const filename = key.split('/').pop() || 'download'
  setResponseHeader(event, 'Content-Type', contentType)
  // Content-Disposition：inline=1 时内联渲染（预览），否则 attachment（下载）
  if (inline) {
    setResponseHeader(event, 'Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`)
  } else {
    setResponseHeader(event, 'Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
  }
  if (contentLength) setResponseHeader(event, 'Content-Length', Number(contentLength))
  if (lastModified) setResponseHeader(event, 'Last-Modified', lastModified)
  if (etag) setResponseHeader(event, 'ETag', etag)
  // Range 请求相关头透传（视频预览必需）
  if (contentRange) setResponseHeader(event, 'Content-Range', contentRange)
  if (acceptRanges) setResponseHeader(event, 'Accept-Ranges', acceptRanges)

  // 如果 MinIO 返回 206 Partial Content，设置响应状态码为 206
  if (response.status === 206) {
    setResponseStatus(event, 206)
  }

  // sendStream 接收 Web ReadableStream（response.body）并管道转发给客户端
  // 仅清理超时定时器，不 cancel 源流（sendStream 会自行处理流消费）
  const res = event.node.res
  res.on('close', () => {
    cleanup?.()
  })
  res.on('error', () => {
    cleanup?.()
  })

  return sendStream(event, response.body!)
})
