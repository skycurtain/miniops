import { cleanupExpired } from '../utils/uploads'

/**
 * Nitro plugin：定时清理过期的孤儿暂存文件。
 *
 * - 启动时清理一次
 * - 每 6 小时清理一次
 * - 超过 UPLOAD_TTL_HOURS（默认 24h）的暂存目录被删除
 */
export default defineNitroPlugin(() => {
  cleanupExpired().catch((e) => {
    console.error('[cleanup] 启动清理失败:', e)
  })
  setInterval(() => {
    cleanupExpired().catch((e) => {
      console.error('[cleanup] 定时清理失败:', e)
    })
  }, 6 * 60 * 60 * 1000)
})
