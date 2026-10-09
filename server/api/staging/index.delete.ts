import { removeStagedFiles, listStagedFiles } from '#server/utils/staging'

/**
 * DELETE /api/staging
 * 删除暂存文件。
 *
 * body/query: { fileIds?: string[] | string }
 * - 指定 fileIds：按列表删除（query 可用逗号分隔）
 * - 不传 / 空：清空全部暂存
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const body = await readBody<{ fileIds?: string[] }>(event).catch(() => null)

  let fileIds: string[] | undefined
  const raw = body?.fileIds ?? query.fileIds
  if (typeof raw === 'string') {
    fileIds = raw.split(',').map((s) => s.trim()).filter(Boolean)
  } else if (Array.isArray(raw)) {
    fileIds = raw.filter((s): s is string => typeof s === 'string' && !!s)
  }

  if (fileIds && fileIds.length > 0) {
    const removed = await removeStagedFiles(fileIds)
    return { removed }
  }

  const all = await listStagedFiles()
  const removed = await removeStagedFiles(all.map((f) => f.fileId))
  return { removed }
})
