import { storeUpload } from '../../utils/uploads'

/**
 * POST /api/uploads
 * multipart 上传单个文件，流式落盘到暂存目录，返回 StoredFile。
 *
 * 请求体: multipart/form-data，字段名 file
 * 响应: 201 Created { StoredFile }
 */
export default defineEventHandler(async (event) => {
  const form = await readMultipartFormData(event)
  const part = form?.find(p => p.name === 'file')
  if (!part) {
    throw createError({ statusCode: 400, statusMessage: '缺少 file 字段' })
  }

  const name = part.filename ?? 'unnamed'
  const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 0
  if (MAX_UPLOAD_SIZE > 0 && part.data.length > MAX_UPLOAD_SIZE) {
    throw createError({ statusCode: 413, statusMessage: '文件超出大小限制' })
  }

  // 可选：前端传入 objectKey（文件夹上传时为相对路径）
  const objectKeyPart = form?.find(p => p.name === 'objectKey')
  const objectKey = objectKeyPart?.data.toString('utf8') || undefined

  const stored = await storeUpload(name, part.data, objectKey)
  setResponseStatus(event, 201)
  return stored
})
