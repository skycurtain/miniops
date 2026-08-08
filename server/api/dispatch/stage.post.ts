import { stageFile } from '#server/utils/staging'
import { sanitizeObjectKey } from '#server/utils/minio'

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

  const contentType = file.type || 'application/octet-stream'
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
