import { stageFile } from '#server/utils/staging'
import { sanitizeObjectKey, inferContentType } from '#server/utils/s3'

/**
 * POST /api/dispatch/stage
 * 暂存单个文件到后端磁盘。
 *
 * 请求: multipart/form-data
 *   file: 文件流
 *   objectKey: string
 *   originalName: string
 *
 * 响应: { fileId: string }
 */
export default defineEventHandler(async (event) => {
  const form = await readFormData(event)
  const file = form.get('file') as File | null
  const objectKey = form.get('objectKey') as string | null
  const originalName = form.get('originalName') as string | null

  if (!file) {
    throw createError({ statusCode: 400, message: '缺少文件' })
  }
  if (!objectKey) {
    throw createError({ statusCode: 400, message: '缺少 objectKey' })
  }

  // Content-Type 按扩展名推断，不信任 file.type：
  // Bun 运行时的 formData() 解析 multipart 时会给 Content-Type 追加 ;charset=utf-8
  // （如 application/json -> application/json;charset=utf-8），Node/undici 则不会。
  // 该值会原样写入 MinIO，带 charset 会导致 MinIO Console 无法预览。
  const contentType = inferContentType(objectKey)
  const buffer = Buffer.from(await file.arrayBuffer())

  const staged = await stageFile(
    buffer,
    sanitizeObjectKey(objectKey),
    originalName || file.name,
    contentType,
    file.size,
  )

  return { fileId: staged.fileId }
})
