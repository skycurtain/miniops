import { listStagedFiles } from '#server/utils/staging'

/**
 * GET /api/staging
 * 列出当前暂存文件（含进程重启后从磁盘恢复的孤儿）。
 */
export default defineEventHandler(async () => {
  const files = await listStagedFiles()
  return { files }
})
