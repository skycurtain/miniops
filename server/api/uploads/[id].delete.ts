import { getStoredFile, deleteStoredFile } from '../../utils/uploads'

/**
 * DELETE /api/uploads/:id
 * 删除单个暂存文件（前端移除文件时调用）。
 *
 * 响应: 204 No Content
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const stored = getStoredFile(id)
  if (!stored) {
    throw createError({ statusCode: 404, statusMessage: '文件不存在' })
  }
  await deleteStoredFile(id)
  setResponseStatus(event, 204)
})
