import { storeUploadFromStream } from '../../utils/uploads'

/**
 * POST /api/uploads
 * multipart 上传单个文件，流式落盘到暂存目录，返回 StoredFile。
 *
 * 使用 h3 的 readFormData（基于 Web Streams API 的 Request.formData()），
 * 流式解析 multipart，避免 readMultipartFormData 对大文件逐字节 push 导致的
 * RangeError 和内存爆炸。返回的 File 对象通过 .stream() 流式落盘。
 *
 * 请求体: multipart/form-data，字段名 file
 * 响应: 201 Created { StoredFile }
 */
export default defineEventHandler(async (event) => {
  const form = await readFormData(event)
  const file = form.get('file')

  if (!file || !(file instanceof File)) {
    throw createError({ statusCode: 400, statusMessage: '缺少 file 字段' })
  }

  const name = file.name || 'unnamed'
  const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 0
  if (MAX_UPLOAD_SIZE > 0 && file.size > MAX_UPLOAD_SIZE) {
    throw createError({ statusCode: 413, statusMessage: '文件超出大小限制' })
  }

  // 可选：前端传入 objectKey（文件夹上传时为相对路径）
  const objectKeyEntry = form.get('objectKey')
  const objectKey = typeof objectKeyEntry === 'string' ? objectKeyEntry : undefined

  const stored = await storeUploadFromStream(name, file.stream(), file.size, file.type || undefined, objectKey)
  setResponseStatus(event, 201)
  return stored
})
