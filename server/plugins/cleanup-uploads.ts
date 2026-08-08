import { cleanupOrphanedFiles } from '#server/utils/staging'

const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000 // 6 小时

export default defineNitroPlugin((nitroApp) => {
  // 启动时清理一次
  void cleanupOrphanedFiles()

  // 定时清理
  const interval = setInterval(() => {
    void cleanupOrphanedFiles()
  }, CLEANUP_INTERVAL)

  // Nitro 关闭时清除定时器
  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
  })
})
