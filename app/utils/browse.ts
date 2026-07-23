/**
 * 实例访问页面的前端工具函数
 *
 * 从原型 mock-data.ts 提取的纯函数，不依赖 mock 数据。
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatSize(bytes: number): string {
  if (bytes <= 0) return '-'
  let i = 0
  let val = bytes
  while (val >= 1024 && i < UNITS.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${UNITS[i]}`
}

export function formatDate(iso: string): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 根据扩展名返回文件图标 */
export function fileIcon(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext))
    return 'i-lucide-file-image'
  if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext)) return 'i-lucide-file-video'
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext)) return 'i-lucide-file-audio'
  if (['zip', 'gz', 'tar', 'tgz', 'rar', '7z'].includes(ext)) return 'i-lucide-file-archive'
  if (['json'].includes(ext)) return 'i-lucide-file-json'
  if (['js', 'ts', 'mjs', 'css', 'html', 'htm', 'vue', 'sh'].includes(ext))
    return 'i-lucide-file-code'
  if (['txt', 'csv', 'xml', 'log', 'md', 'yaml', 'yml', 'conf', 'ini'].includes(ext))
    return 'i-lucide-file-text'
  return 'i-lucide-file'
}

/** 判断预览类型 */
export type PreviewType = 'image' | 'video' | 'audio' | 'text' | null

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']
const VIDEO_EXTS = ['mp4', 'webm', 'ogg']
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'aac', 'flac']
const TEXT_EXTS = [
  'txt',
  'json',
  'csv',
  'xml',
  'log',
  'md',
  'js',
  'ts',
  'mjs',
  'css',
  'html',
  'htm',
  'yaml',
  'yml',
  'ini',
  'conf',
  'sh',
  'bat',
  'sql',
  'env',
  'toml',
  'properties',
  'vue',
]

export function getPreviewType(key: string): PreviewType {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (TEXT_EXTS.includes(ext)) return 'text'
  return null
}

/** 从 objectKey 中提取显示名（去掉前缀） */
export function displayName(key: string, prefix: string): string {
  const stripped = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
  return stripped.split('/').pop() ?? key
}
