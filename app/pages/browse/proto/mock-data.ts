/**
 * Mock 数据 - 实例访问原型
 *
 * 原型专用 mock 数据，不对接真实 API。
 * 包含分组/实例、bucket 列表、对象列表的静态数据，
 * 以及模拟异步加载、分页、上传/下载/复制/移动进度的辅助函数。
 */

// ==================== 类型 ====================

export interface MockInstance {
  id: string
  name: string
  endpoint: string
  enabled: boolean
}

export interface MockGroup {
  id: string
  name: string
  isDefault?: boolean
  instances: MockInstance[]
}

/** 对象信息 */
export interface ObjectInfo {
  key: string
  size: number
  lastModified: string
}

/** bucket 信息 */
export interface BucketInfo {
  name: string
  createdAt: string
}

// ==================== 分组与实例 ====================

export const mockGroups: MockGroup[] = [
  {
    id: 'grp-default',
    name: '默认',
    isDefault: true,
    instances: [
      { id: 'inst-1', name: '站A', endpoint: 'http://10.0.0.1:9000', enabled: true },
      { id: 'inst-7', name: '华南区域生产环境核心数据存储集群-深圳机房A区-对象存储专用节点', endpoint: 'http://10.0.0.7:9000', enabled: true },
    ],
  },
  {
    id: 'grp-1',
    name: '分组 X',
    instances: [
      { id: 'inst-2', name: '站B', endpoint: 'http://10.0.0.2:9000', enabled: true },
      { id: 'inst-3', name: '站C', endpoint: 'http://10.0.0.3:9000', enabled: false },
      { id: 'inst-9', name: '站G', endpoint: 'http://10.0.0.9:9000', enabled: true },
    ],
  },
  {
    id: 'grp-long',
    name: '华东区域灾备环境核心数据存储集群-上海机房B区-对象存储专用',
    instances: [
      { id: 'inst-8', name: '沪B主节点-高可用集群-读写分离模式', endpoint: 'http://10.0.0.8:9000', enabled: true },
    ],
  },
  {
    id: 'grp-2',
    name: '分组 Y',
    instances: [
      { id: 'inst-4', name: '站D', endpoint: 'http://10.0.0.4:9000', enabled: true },
      { id: 'inst-5', name: '站E', endpoint: 'http://10.0.0.5:9000', enabled: true },
      { id: 'inst-6', name: '站F', endpoint: 'http://10.0.0.6:9000', enabled: true },
    ],
  },
]

/** 扁平化取所有 enabled 实例 */
export function getEnabledInstances(groups: MockGroup[]): MockInstance[] {
  return groups.flatMap((g) => g.instances.filter((i) => i.enabled))
}

// ==================== Bucket 列表 ====================

const bucketsByInstance: Record<string, BucketInfo[]> = {
  'inst-1': [
    { name: 'logs', createdAt: '2025-03-12T08:30:00Z' },
    { name: 'backups', createdAt: '2025-01-05T10:00:00Z' },
    { name: 'configs', createdAt: '2025-06-18T14:20:00Z' },
    { name: 'media', createdAt: '2025-04-22T09:15:00Z' },
  ],
  'inst-2': [
    { name: 'data', createdAt: '2025-02-10T12:00:00Z' },
    { name: 'temp', createdAt: '2025-07-01T16:45:00Z' },
  ],
  'inst-4': [
    { name: 'prod-assets', createdAt: '2024-11-15T08:00:00Z' },
    { name: 'prod-logs', createdAt: '2024-09-20T03:30:00Z' },
  ],
  'inst-5': [
    { name: 'archive', createdAt: '2024-12-01T11:00:00Z' },
  ],
  'inst-7': [
    { name: 'shenzhen-primary', createdAt: '2024-08-10T07:00:00Z' },
    { name: 'shenzhen-replica', createdAt: '2024-08-10T07:05:00Z' },
    { name: 'configs', createdAt: '2025-05-03T13:00:00Z' },
  ],
  'inst-8': [
    { name: 'shanghai-dr', createdAt: '2024-10-22T09:00:00Z' },
    { name: 'shanghai-hot', createdAt: '2025-01-15T10:30:00Z' },
  ],
}

/** 模拟异步拉取 bucket 列表 */
export async function fetchBuckets(instanceId: string): Promise<BucketInfo[]> {
  await delay(600)
  // 站F 模拟拉取失败（凭据异常 / 权限不足）
  if (instanceId === 'inst-6') throw new Error('Access Denied: 凭据异常，无法列出 bucket')
  return structuredClone(bucketsByInstance[instanceId] ?? [])
}

// ==================== 对象列表 ====================

/** 单个对象的 mock 定义 */
interface MockObjectSeed {
  name: string
  size: number
  type: 'text' | 'image' | 'video' | 'audio' | 'archive' | 'other'
  daysAgo: number
}

const objectSeedsByBucket: Record<string, MockObjectSeed[]> = {
  logs: [
    { name: 'app.log', size: 45_000, type: 'text', daysAgo: 1 },
    { name: 'error.log', size: 12_300, type: 'text', daysAgo: 2 },
    { name: 'access/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'nginx/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'system.log', size: 8_900, type: 'text', daysAgo: 3 },
    { name: 'debug.json', size: 2_400, type: 'text', daysAgo: 1 },
    { name: 'metrics/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'rotation.log', size: 123_000, type: 'text', daysAgo: 5 },
    { name: 'audit.csv', size: 34_500, type: 'text', daysAgo: 4 },
    { name: 'health.json', size: 890, type: 'text', daysAgo: 1 },
    { name: '2024/', size: 0, type: 'other', daysAgo: 0 },
    { name: '2025/', size: 0, type: 'other', daysAgo: 0 },
  ],
  backups: [
    { name: 'db-dump-20260715.sql.gz', size: 456_000_000, type: 'archive', daysAgo: 2 },
    { name: 'db-dump-20260714.sql.gz', size: 432_000_000, type: 'archive', daysAgo: 3 },
    { name: 'weekly/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'config-snapshot.json', size: 5_600, type: 'text', daysAgo: 2 },
    { name: 'redis-dump.rdb', size: 89_000_000, type: 'other', daysAgo: 2 },
    { name: 'monthly/', size: 0, type: 'other', daysAgo: 0 },
  ],
  configs: [
    { name: 'app.json', size: 1_200, type: 'text', daysAgo: 1 },
    { name: 'config.yaml', size: 3_400, type: 'text', daysAgo: 2 },
    { name: 'logo.png', size: 45_000, type: 'image', daysAgo: 15 },
    { name: 'env/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'nginx.conf', size: 2_100, type: 'text', daysAgo: 7 },
    { name: 'demo.mp4', size: 125_000_000, type: 'video', daysAgo: 10 },
    { name: 'theme.css', size: 8_900, type: 'text', daysAgo: 5 },
    { name: 'music.mp3', size: 3_400_000, type: 'audio', daysAgo: 8 },
    { name: 'data/', size: 0, type: 'other', daysAgo: 0 },
  ],
  media: [
    { name: 'banner.jpg', size: 234_000, type: 'image', daysAgo: 3 },
    { name: 'intro.webm', size: 5_600_000, type: 'video', daysAgo: 7 },
    { name: 'icons/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'photos/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'screenshot.png', size: 890_000, type: 'image', daysAgo: 1 },
    { name: 'background.svg', size: 12_000, type: 'image', daysAgo: 12 },
    { name: 'audio/', size: 0, type: 'other', daysAgo: 0 },
  ],
  data: [
    { name: 'dataset.json', size: 1_200_000, type: 'text', daysAgo: 1 },
    { name: 'exports/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'raw/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'report.csv', size: 56_700, type: 'text', daysAgo: 2 },
    { name: 'backup.tar', size: 234_000_000, type: 'archive', daysAgo: 5 },
  ],
  temp: [
    { name: 'test.txt', size: 120, type: 'text', daysAgo: 1 },
    { name: 'scratch.json', size: 450, type: 'text', daysAgo: 1 },
  ],
  'prod-assets': [
    { name: 'index.html', size: 3_400, type: 'text', daysAgo: 1 },
    { name: 'bundle.js', size: 456_000, type: 'text', daysAgo: 1 },
    { name: 'styles.css', size: 89_000, type: 'text', daysAgo: 1 },
    { name: 'images/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'fonts/', size: 0, type: 'other', daysAgo: 0 },
  ],
  'prod-logs': [
    { name: 'request.log', size: 5_600_000, type: 'text', daysAgo: 1 },
    { name: 'error/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'slow-query.log', size: 2_300_000, type: 'text', daysAgo: 1 },
  ],
  archive: [
    { name: '2024-Q1/', size: 0, type: 'other', daysAgo: 0 },
    { name: '2024-Q2/', size: 0, type: 'other', daysAgo: 0 },
    { name: '2024-Q3/', size: 0, type: 'other', daysAgo: 0 },
    { name: '2024-Q4/', size: 0, type: 'other', daysAgo: 0 },
    { name: 'readme.md', size: 340, type: 'text', daysAgo: 30 },
  ],
}

/** 子前缀下的额外 mock 对象（进入子文件夹时用） */
const subFolderSeeds: MockObjectSeed[] = [
  { name: 'file-1.json', size: 1_200, type: 'text', daysAgo: 2 },
  { name: 'file-2.csv', size: 3_400, type: 'text', daysAgo: 3 },
  { name: 'image.png', size: 45_000, type: 'image', daysAgo: 5 },
  { name: 'sub/', size: 0, type: 'other', daysAgo: 0 },
  { name: 'document.txt', size: 890, type: 'text', daysAgo: 1 },
  { name: 'archive.zip', size: 234_000, type: 'archive', daysAgo: 7 },
]

export interface ListObjectsResult {
  objects: ObjectInfo[]
  commonPrefixes: string[]
  isTruncated: boolean
}

/** 模拟 ListObjectsV2（delimiter=/，虚拟文件夹模式） */
export async function fetchObjects(
  instanceId: string,
  bucket: string,
  prefix: string,
): Promise<ListObjectsResult> {
  await delay(500)

  const seeds = objectSeedsByBucket[bucket] ?? subFolderSeeds

  // 前缀非空时用通用子文件夹 mock（模拟进入任意子目录）
  const effectiveSeeds = prefix ? subFolderSeeds : seeds

  const now = Date.now()
  const objects: ObjectInfo[] = []
  const commonPrefixes: string[] = []

  for (const seed of effectiveSeeds) {
    const fullKey = prefix + seed.name
    if (seed.name.endsWith('/')) {
      commonPrefixes.push(fullKey)
    } else {
      objects.push({
        key: fullKey,
        size: seed.size,
        lastModified: new Date(now - seed.daysAgo * 86400_000).toISOString(),
      })
    }
  }

  // 模拟分页：超过 8 个对象时标记可加载更多
  const isTruncated = objects.length > 8
  const visibleObjects = isTruncated ? objects.slice(0, 8) : objects

  return { objects: visibleObjects, commonPrefixes, isTruncated }
}

/** 模拟加载更多（追加剩余对象） */
export async function fetchMoreObjects(
  _instanceId: string,
  _bucket: string,
  _prefix: string,
): Promise<ListObjectsResult> {
  await delay(400)
  const now = Date.now()
  return {
    objects: Array.from({ length: 3 }, (_, i) => ({
      key: `${_prefix}extra-${i + 1}.log`,
      size: 1000 * (i + 1),
      lastModified: new Date(now - i * 86400_000).toISOString(),
    })),
    commonPrefixes: [],
    isTruncated: false,
  }
}

// ==================== 预览内容 ====================

export function getPreviewContent(key: string): { type: string; content: string } {
  if (key.endsWith('.json')) {
    return { type: 'text', content: '{\n  "name": "miniops",\n  "version": "1.0.0",\n  "features": [\n    "browse",\n    "upload",\n    "sync"\n  ]\n}' }
  }
  if (key.endsWith('.yaml') || key.endsWith('.yml')) {
    return { type: 'text', content: 'server:\n  port: 9000\n  host: 0.0.0.0\n\nstorage:\n  driver: minio\n  endpoint: http://10.0.0.1:9000' }
  }
  if (key.endsWith('.log')) {
    return { type: 'text', content: '[2026-07-16 10:32:01] INFO  Server started on :9000\n[2026-07-16 10:32:05] INFO  Health check passed\n[2026-07-16 10:33:12] WARN  High memory usage: 87%\n[2026-07-16 10:34:00] INFO  Background task completed' }
  }
  if (key.endsWith('.csv')) {
    return { type: 'text', content: 'id,name,size,modified\n1,app.json,1200,2026-07-16\n2,config.yaml,3400,2026-07-15\n3,logo.png,45000,2026-07-01' }
  }
  if (key.endsWith('.txt') || key.endsWith('.md')) {
    return { type: 'text', content: '这是 mock 文本预览内容。\n\n实例访问原型演示文本类文件预览功能。\n实际实现中后端会代理获取文件内容，前端做语法高亮渲染。' }
  }
  if (key.endsWith('.css')) {
    return { type: 'text', content: ':root {\n  --primary: #3b82f6;\n  --bg: #ffffff;\n}\n\nbody {\n  font-family: sans-serif;\n  background: var(--bg);\n}' }
  }
  if (key.endsWith('.js') || key.endsWith('.ts')) {
    return { type: 'text', content: "import { createServer } from 'http'\n\nconst server = createServer((req, res) => {\n  res.writeHead(200)\n  res.end('Hello from miniops')\n})\n\nserver.listen(3000)" }
  }
  if (key.endsWith('.html')) {
    return { type: 'text', content: '<!DOCTYPE html>\n<html>\n<head>\n  <title>miniops</title>\n</head>\n<body>\n  <h1>Hello World</h1>\n</body>\n</html>' }
  }
  return { type: 'binary', content: '' }
}

// ==================== 工具函数 ====================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  if (['zip', 'gz', 'tar', 'tgz', 'rar', '7z'].includes(ext))
    return 'i-lucide-file-archive'
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
  'txt', 'json', 'csv', 'xml', 'log', 'md',
  'js', 'ts', 'mjs', 'css', 'html', 'htm',
  'yaml', 'yml', 'ini', 'conf', 'sh', 'bat',
  'sql', 'env', 'toml', 'properties', 'vue',
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
