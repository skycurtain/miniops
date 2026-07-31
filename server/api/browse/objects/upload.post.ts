import { getGroups } from '#server/utils/store'
import { uploadObjectStream, sanitizeObjectKey, inferContentType } from '#server/utils/minio'
import type { MinioInstance } from '#shared/schemas/groups'

/**
 * POST /api/browse/objects/upload
 * 流式上传对象（后端转发，不落盘）。
 *
 * 请求体: multipart/form-data
 *   - instanceId: string
 *   - bucket: string
 *   - prefix: string（目标前缀，留空=根）
 *   - file: File
 *
 * 响应: 201 { key, size }
 */
export default defineEventHandler(async (event) => {
  const form = await readFormData(event)

  const instanceId = form.get('instanceId') as string | null
  const bucket = form.get('bucket') as string | null
  const prefix = (form.get('prefix') as string | null) ?? ''
  const relativePath = (form.get('relativePath') as string | null) ?? ''
  const file = form.get('file')

  if (!instanceId) {
    throw createError({ statusCode: 400, message: '缺少 instanceId' })
  }
  if (!bucket) {
    throw createError({ statusCode: 400, message: '缺少 bucket' })
  }
  if (!file || !(file instanceof File)) {
    throw createError({ statusCode: 400, message: '缺少 file' })
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

  // 构造 objectKey：prefix + 相对路径（文件夹上传时保留目录结构）
  // relativePath 可能是 "myfolder/sub/file.txt"（文件夹上传）或 "file.txt"（单文件）
  const pathPart = relativePath || file.name
  const rawKey = prefix ? `${prefix}/${pathPart}` : pathPart
  const objectKey = sanitizeObjectKey(rawKey)

  // 推断 Content-Type
  const contentType = inferContentType(file.name)

  // 读取文件内容为 Uint8Array（SDK 无法对 Web ReadableStream 计算 checksum）
  const body = new Uint8Array(await file.arrayBuffer())

  await uploadObjectStream(instance, bucket, objectKey, body, contentType, file.size)

  setResponseStatus(event, 201)
  return { key: objectKey, size: file.size }
})
