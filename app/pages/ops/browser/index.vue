<script setup lang="ts">
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import BrowserUploadModal from '~/components/BrowserUploadModal.vue'
// useSync 在 browser 页实例化，通过 props 传入 SyncTargetModal
const sync = useSync()

// ---------- 类型定义（与后端对齐） ----------
interface MinioInstance {
  id: string
  groupId: string
  name: string
  endpoint: string
  accessKey: string
  secretKey: string
  enabled: boolean
}
interface InstanceGroup {
  id: string
  name: string
  description?: string
  instances: MinioInstance[]
  isDefault?: boolean
  createdAt: string
  updatedAt: string
}
interface ObjectInfo {
  key: string
  size: number
  lastModified: string
  etag?: string
}
interface ListObjectsResult {
  objects: ObjectInfo[]
  commonPrefixes: string[]
  isTruncated: boolean
  continuationToken?: string
}
interface DeleteObjectsResult {
  deleted: string[]
  errors: { key: string, error: string }[]
}

// ---------- 数据获取：实例列表 ----------
const { data: groups } = await useFetch<InstanceGroup[]>('/api/groups', { default: () => [] })

// 实例下拉选项（扁平列表，标签含组名前缀）
const instanceItems = computed(() => {
  const items: { label: string, value: string }[] = []
  for (const g of groups.value) {
    for (const i of g.instances) {
      if (i.enabled) {
        items.push({ label: `${g.name} / ${i.name} (${i.endpoint})`, value: i.id })
      }
    }
  }
  return items
})

// 找实例对象
function findInstance(id: string): MinioInstance | undefined {
  for (const g of groups.value) {
    const inst = g.instances.find(i => i.id === id)
    if (inst) return inst
  }
  return undefined
}

// ---------- 选中的实例 / bucket ----------
const selectedInstanceId = ref<string>('')
const selectedBucket = ref<string>('')
const selectedInstance = computed(() => selectedInstanceId.value ? findInstance(selectedInstanceId.value) : undefined)

// 深链暂存：从 URL 读取的 bucket/prefix，等实例 bucket 列表加载完后恢复
const pendingDeepLink = ref<{ bucket?: string; prefix?: string } | null>(null)

// bucket 列表
const bucketList = ref<string[]>([])
const bucketLoading = ref(false)
const bucketError = ref<string>('')
const bucketManualInput = ref<string>('')

async function loadBuckets() {
  if (!selectedInstanceId.value) return
  bucketLoading.value = true
  bucketError.value = ''
  bucketList.value = []
  selectedBucket.value = ''
  bucketManualInput.value = ''
  try {
    const res = await $fetch<Record<string, { buckets: string[], error?: string }>>('/api/instances/buckets', {
      method: 'POST',
      body: { instanceIds: [selectedInstanceId.value] },
    })
    const data = res[selectedInstanceId.value]
    if (data?.error) {
      bucketError.value = data.error
    }
    else {
      bucketList.value = data?.buckets ?? []
    }
  }
  catch (e: any) {
    bucketError.value = e?.data?.statusMessage || e?.message || '加载失败'
  }
  finally {
    bucketLoading.value = false
  }
}

// 实例变化时加载 bucket
watch(selectedInstanceId, () => {
  objects.value = []
  commonPrefixes.value = []
  continuationToken.value = undefined
  currentPrefix.value = ''
  selectedKeys.value = new Set()
  selectedPrefixes.value = new Set()
  if (selectedInstanceId.value) {
    loadBuckets()
  }
})

// bucket 变化时加载对象
watch(selectedBucket, (newBucket) => {
  // 深链恢复：如果有暂存的 prefix，先恢复再加载
  if (newBucket && pendingDeepLink.value?.prefix) {
    currentPrefix.value = pendingDeepLink.value.prefix
    pendingDeepLink.value = null
    nextTick(() => loadObjects())
  }
  else {
    // 正常切换 bucket：重置到根前缀
    currentPrefix.value = ''
    if (newBucket) loadObjects()
  }
  // 有深链但无 prefix，清除标记
  if (newBucket && pendingDeepLink.value && !pendingDeepLink.value.prefix) {
    pendingDeepLink.value = null
  }
})

// ---------- 对象列表 ----------
const objects = ref<ObjectInfo[]>([])
const commonPrefixes = ref<string[]>([])
const continuationToken = ref<string | undefined>(undefined)
const currentPrefix = ref<string>('')
const objectsLoading = ref(false)
const objectsError = ref<string>('')
const loadingMore = ref(false)

async function loadObjects(token?: string) {
  if (!selectedInstanceId.value || !selectedBucket.value) return
  if (token) {
    loadingMore.value = true
  }
  else {
    objectsLoading.value = true
    objects.value = []
    commonPrefixes.value = []
    continuationToken.value = undefined
    selectedKeys.value = new Set()
    selectedPrefixes.value = new Set()
  }
  objectsError.value = ''

  try {
    const res = await $fetch<ListObjectsResult>('/api/instances/objects/list', {
      method: 'POST',
      body: {
        instanceId: selectedInstanceId.value,
        bucket: selectedBucket.value,
        prefix: currentPrefix.value,
        continuationToken: token,
      },
    })
    if (token) {
      // 加载更多：追加
      objects.value.push(...res.objects)
      commonPrefixes.value.push(...res.commonPrefixes)
    }
    else {
      objects.value = res.objects
      commonPrefixes.value = res.commonPrefixes
    }
    continuationToken.value = res.isTruncated ? res.continuationToken : undefined
  }
  catch (e: any) {
    objectsError.value = e?.data?.statusMessage || e?.message || '加载失败'
  }
  finally {
    objectsLoading.value = false
    loadingMore.value = false
  }
}

// ---------- 前缀导航（面包屑） ----------
const breadcrumbs = computed(() => {
  const p = currentPrefix.value
  if (!p) return [{ label: '根', prefix: '' }]
  const segments = p.replace(/\/$/, '').split('/').filter(Boolean)
  const crumbs = [{ label: '根', prefix: '' }]
  let acc = ''
  for (const seg of segments) {
    acc += `${seg}/`
    crumbs.push({ label: `${seg}/`, prefix: acc })
  }
  return crumbs
})

function navigateToPrefix(prefix: string) {
  currentPrefix.value = prefix
  loadObjects()
}

function navigateToBreadcrumb(index: number) {
  const crumb = breadcrumbs.value[index]
  if (crumb) {
    currentPrefix.value = crumb.prefix
    loadObjects()
  }
}

// 前缀输入框跳转
const prefixInput = ref<string>('')
function jumpToPrefix() {
  const p = prefixInput.value.trim()
  // 空 -> 根
  if (!p) {
    currentPrefix.value = ''
    loadObjects()
    return
  }
  // 清洗：反斜杠归一化、去 ..、去段首点
  const cleaned = p
    .replace(/\\/g, '/')
    .split('/')
    .map(seg => seg.replace(/^\.+/, ''))
    .filter(seg => seg.length > 0 && seg !== '..')
    .join('/')
  // 补尾斜杠
  currentPrefix.value = cleaned ? `${cleaned}/` : ''
  loadObjects()
}

// ---------- 对象显示辅助 ----------
function displayName(key: string): string {
  const prefix = currentPrefix.value
  const stripped = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
  return stripped.split('/').pop() || key
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function fileIcon(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() || ''
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return 'i-lucide-file-image'
  if (['json'].includes(ext)) return 'i-lucide-file-json'
  if (['zip', 'gz', 'tar', 'tgz', 'rar', '7z'].includes(ext)) return 'i-lucide-file-archive'
  if (['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext)) return 'i-lucide-file-video'
  if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) return 'i-lucide-file-audio'
  if (['txt', 'csv', 'xml', 'log', 'md'].includes(ext)) return 'i-lucide-file-text'
  if (['js', 'ts', 'mjs', 'css', 'html', 'htm'].includes(ext)) return 'i-lucide-file-code'
  if (['pdf'].includes(ext)) return 'i-lucide-file-text'
  return 'i-lucide-file'
}

// ---------- 对象预览 ----------
type PreviewType = 'image' | 'video' | 'audio' | 'pdf' | 'text' | null

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']
const VIDEO_EXTS = ['mp4', 'webm', 'ogg']
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'aac', 'flac']
const TEXT_EXTS = [
  'txt', 'json', 'csv', 'xml', 'log', 'md',
  'js', 'ts', 'mjs', 'css', 'html', 'htm',
  'yaml', 'yml', 'ini', 'conf', 'sh', 'bat',
  'sql', 'env', 'toml', 'properties', 'vue',
]
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024 // 2MB

function getPreviewType(key: string): PreviewType {
  const ext = key.split('.').pop()?.toLowerCase() || ''
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (AUDIO_EXTS.includes(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXTS.includes(ext)) return 'text'
  return null
}

// 预览抽屉状态
const previewOpen = ref(false)
const previewKey = ref<string>('')
const previewType = ref<PreviewType>(null)
const previewUrl = ref<string>('')
const previewError = ref<string>('')

// 文本预览专用状态
const textContent = ref<string>('')
const textLoading = ref(false)
const textError = ref<string>('')

// 当前预览对象的元信息（从 objects 列表查找）
const previewObject = computed(() => objects.value.find(o => o.key === previewKey.value))

function buildPreviewUrl(key: string): string {
  const params = new URLSearchParams({
    instanceId: selectedInstanceId.value,
    bucket: selectedBucket.value,
    key,
    inline: '1',
  })
  return `/api/instances/objects/download?${params.toString()}`
}

async function openPreview(key: string) {
  const type = getPreviewType(key)
  if (!type) return

  previewKey.value = key
  previewType.value = type
  previewUrl.value = buildPreviewUrl(key)
  previewError.value = ''
  textContent.value = ''
  textError.value = ''
  previewOpen.value = true

  // 文本类型：fetch 内容
  if (type === 'text') {
    await fetchTextContent(key)
  }
}

function closePreview() {
  previewOpen.value = false
  previewKey.value = ''
  previewType.value = null
  previewUrl.value = ''
  previewError.value = ''
  textContent.value = ''
  textError.value = ''
}

async function fetchTextContent(key: string) {
  // 检查大小（从 objects 列表查）
  const obj = objects.value.find(o => o.key === key)
  if (obj && obj.size > TEXT_PREVIEW_LIMIT) {
    textError.value = `文件过大（${formatSize(obj.size)} > 2MB），请下载后查看`
    return
  }

  textLoading.value = true
  textError.value = ''
  textContent.value = ''

  try {
    const res = await fetch(buildPreviewUrl(key))
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const text = await res.text()

    // 二进制误判兜底：检测 replacement character 占比
    if (text.length > 0) {
      const replacementCount = (text.match(/\uFFFD/g) || []).length
      if (replacementCount / text.length > 0.1) {
        textError.value = '该文件可能不是文本文件，请下载后查看'
        return
      }
    }

    textContent.value = text
  }
  catch (e: any) {
    textError.value = e?.message || '加载失败'
  }
  finally {
    textLoading.value = false
  }
}

function onPreviewError() {
  previewError.value = '加载失败，对象可能不存在或格式不支持'
}

// ---------- 多选 ----------
// selectedKeys 存对象 key，selectedPrefixes 存文件夹前缀
const selectedKeys = ref<Set<string>>(new Set())
const selectedPrefixes = ref<Set<string>>(new Set())

function toggleSelect(key: string) {
  const set = new Set(selectedKeys.value)
  set.has(key) ? set.delete(key) : set.add(key)
  selectedKeys.value = set
}

function toggleSelectPrefix(prefix: string) {
  const set = new Set(selectedPrefixes.value)
  set.has(prefix) ? set.delete(prefix) : set.add(prefix)
  selectedPrefixes.value = set
}

// 当前页全部可选项（对象 + 文件夹）
const allSelectable = computed(() => [
  ...commonPrefixes.value,
  ...objects.value.map(o => o.key),
])
const selectedCount = computed(() => selectedKeys.value.size + selectedPrefixes.value.size)
const selectedFolderCount = computed(() => selectedPrefixes.value.size)
const hasFolderSelected = computed(() => selectedPrefixes.value.size > 0)
const isAllSelected = computed(() =>
  allSelectable.value.length > 0 && allSelectable.value.every(k => selectedKeys.value.has(k) || selectedPrefixes.value.has(k)),
)
const isPartialSelected = computed(() =>
  allSelectable.value.some(k => selectedKeys.value.has(k) || selectedPrefixes.value.has(k)) && !isAllSelected.value,
)

function toggleSelectAll() {
  const keySet = new Set(selectedKeys.value)
  const prefixSet = new Set(selectedPrefixes.value)
  if (isAllSelected.value) {
    // 取消当前页全选
    for (const cp of commonPrefixes.value) prefixSet.delete(cp)
    for (const o of objects.value) keySet.delete(o.key)
  }
  else {
    // 选中当前页全部
    for (const cp of commonPrefixes.value) prefixSet.add(cp)
    for (const o of objects.value) keySet.add(o.key)
  }
  selectedKeys.value = keySet
  selectedPrefixes.value = prefixSet
}

// 选中对象的详情（用于删除确认展示）
const selectedObjects = computed(() =>
  objects.value.filter(o => selectedKeys.value.has(o.key)),
)
// 选中的文件夹列表（用于删除确认展示）
const selectedFolders = computed(() =>
  Array.from(selectedPrefixes.value),
)

// ---------- 下载 ----------
const downloading = ref(false)

async function downloadObject(key: string) {
  // 后端流式代理：直接触发浏览器下载
  const params = new URLSearchParams({
    instanceId: selectedInstanceId.value,
    bucket: selectedBucket.value,
    key,
  })
  // 用 a 标签触发下载，避免 fetch 拦截
  const a = document.createElement('a')
  a.href = `/api/instances/objects/download?${params.toString()}`
  a.download = key.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

async function downloadSelected() {
  const keys = Array.from(selectedKeys.value)
  const prefixes = Array.from(selectedPrefixes.value)
  if (!keys.length && !prefixes.length) return

  const toast = useToast()
  downloading.value = true

  try {
    // 用 fetch 发起 POST，拿 blob 后触发下载（因为 POST 请求不能用 a 标签直接触发）
    const blob = await $fetch<Blob>('/api/instances/objects/download-batch', {
      method: 'POST',
      body: {
        instanceId: selectedInstanceId.value,
        bucket: selectedBucket.value,
        keys,
        prefixes,
      },
      responseType: 'blob',
    })

    // 触发浏览器下载
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // 从响应头拿文件名，默认 miniops-download.zip
    a.download = `miniops-download-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    const total = keys.length + prefixes.length
    toast.add({ title: `已下载 ${total} 项（ZIP 打包）`, color: 'success' })
  }
  catch (e: any) {
    // 尝试从 blob 中读取错误信息
    let errMsg = e?.data?.statusMessage || e?.message || '下载失败'
    if (e?.data instanceof Blob) {
      try {
        const text = await e.data.text()
        try {
          const json = JSON.parse(text)
          errMsg = json.statusMessage || json.message || text
        } catch {
          errMsg = text
        }
      }
      catch {}
    }
    console.error('[download-batch] 下载失败:', errMsg, e)
    toast.add({ title: '下载失败', description: errMsg, color: 'error' })
  }
  finally {
    downloading.value = false
  }
}

async function copyPresignUrl(key: string) {
  const toast = useToast()
  try {
    const res = await $fetch<{ url: string }>('/api/instances/objects/presign', {
      method: 'POST',
      body: {
        instanceId: selectedInstanceId.value,
        bucket: selectedBucket.value,
        key,
      },
    })
    await navigator.clipboard.writeText(res.url)
    toast.add({ title: '下载链接已复制', description: '15 分钟内有效', color: 'success' })
  }
  catch (e: any) {
    toast.add({ title: '复制失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
}

// ---------- 删除 ----------
const deleting = ref(false)

async function deleteSingle(key: string) {
  const inst = selectedInstance.value
  const toast = useToast()
  const overlay = useOverlay()
  const modal = overlay.create(ConfirmDialog, { destroyOnClose: true })
  const confirm = await modal.open({
    title: '确认删除',
    description: `确认删除对象「${displayName(key)}」？目标：${inst?.name ?? ''} / ${selectedBucket.value}。此操作不可恢复。`,
    confirmText: '确认删除',
    confirmColor: 'error',
    confirmIcon: 'i-lucide-trash-2',
  })
  if (!confirm) return

  deleting.value = true
  try {
    const res = await $fetch<DeleteObjectsResult>('/api/instances/objects/delete', {
      method: 'POST',
      body: {
        instanceId: selectedInstanceId.value,
        bucket: selectedBucket.value,
        keys: [key],
      },
    })
    if (res.errors.length) {
      toast.add({ title: '删除失败', description: res.errors[0]?.error, color: 'error' })
    }
    else {
      toast.add({ title: '已删除', description: displayName(key), color: 'success' })
      await loadObjects()
    }
  }
  catch (e: any) {
    toast.add({ title: '删除失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
  finally {
    deleting.value = false
  }
}

async function deleteSelected() {
  const keys = Array.from(selectedKeys.value)
  const prefixes = Array.from(selectedPrefixes.value)
  if (!keys.length && !prefixes.length) return
  const inst = selectedInstance.value
  const toast = useToast()
  const overlay = useOverlay()
  const modal = overlay.create(ConfirmDialog, { destroyOnClose: true })

  const totalSize = selectedObjects.value.reduce((s, o) => s + o.size, 0)

  // 构建确认弹窗描述：区分文件夹和对象
  let desc: string
  if (prefixes.length && keys.length) {
    // 同时有文件夹和对象
    const folderList = prefixes.map(p => `  • 📁 ${p.replace(currentPrefix.value, '')}`).join('\n')
    const objList = selectedObjects.value
      .map(o => `  • ${displayName(o.key)} (${formatSize(o.size)})`)
      .join('\n')
    const objDisplay = objList.length > 300 ? `${objList.slice(0, 300)}\n  …等 ${keys.length} 个对象` : objList
    desc = `即将删除 ${keys.length} 个对象（共 ${formatSize(totalSize)}）+ ${prefixes.length} 个文件夹\n\n文件夹（将递归删除其下所有对象）:\n${folderList}\n\n对象:\n${objDisplay}\n\n目标：${inst?.name ?? ''} / ${selectedBucket.value}\n\n此操作不可恢复。`
  }
  else if (prefixes.length) {
    // 只有文件夹
    const folderList = prefixes.map(p => `  • 📁 ${p.replace(currentPrefix.value, '')}`).join('\n')
    desc = `即将递归删除 ${prefixes.length} 个文件夹（其下所有对象将被删除）\n\n文件夹列表:\n${folderList}\n\n目标：${inst?.name ?? ''} / ${selectedBucket.value}\n\n此操作不可恢复。`
  }
  else {
    // 只有对象
    const objList = selectedObjects.value
      .map(o => `  • ${displayName(o.key)} (${formatSize(o.size)})`)
      .join('\n')
    const objDisplay = objList.length > 500 ? `${objList.slice(0, 500)}\n  …等 ${keys.length} 个对象` : objList
    desc = `即将删除 ${keys.length} 个对象（共 ${formatSize(totalSize)}）\n\n对象列表:\n${objDisplay}\n\n目标：${inst?.name ?? ''} / ${selectedBucket.value}\n\n此操作不可恢复。`
  }

  const confirm = await modal.open({
    title: '确认删除',
    description: desc,
    confirmText: '确认删除',
    confirmColor: 'error',
    confirmIcon: 'i-lucide-trash-2',
  })
  if (!confirm) return

  deleting.value = true
  try {
    const res = await $fetch<DeleteObjectsResult>('/api/instances/objects/delete', {
      method: 'POST',
      body: {
        instanceId: selectedInstanceId.value,
        bucket: selectedBucket.value,
        keys,
        prefixes,
      },
    })
    const okCount = res.deleted.length
    const failCount = res.errors.length
    if (failCount && okCount) {
      toast.add({
        title: `已删除 ${okCount} 个，${failCount} 个失败`,
        color: 'warning',
      })
    }
    else if (failCount) {
      toast.add({ title: '删除失败', description: res.errors[0]?.error, color: 'error' })
    }
    else {
      toast.add({ title: `已删除 ${okCount} 个对象`, color: 'success' })
    }
    selectedKeys.value = new Set()
    selectedPrefixes.value = new Set()
    await loadObjects()
  }
  catch (e: any) {
    toast.add({ title: '删除失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
  finally {
    deleting.value = false
  }
}

// ---------- 刷新 ----------
function refresh() {
  loadObjects()
}

// ---------- URL 状态同步 ----------
const route = useRoute()
const router = useRouter()

// 初始化：从 URL 读取
onMounted(() => {
  const qInstanceId = route.query.instanceId as string
  const qBucket = route.query.bucket as string
  const qPrefix = route.query.prefix as string
  if (qInstanceId) {
    // 先暂存深链的 bucket/prefix，等实例 watcher 重置后再恢复
    if (qBucket || qPrefix) {
      pendingDeepLink.value = { bucket: qBucket, prefix: qPrefix }
    }
    selectedInstanceId.value = qInstanceId
  }
})

// 状态变化时更新 URL（replace，不触发跳转）
watch([selectedInstanceId, selectedBucket, currentPrefix], () => {
  router.replace({
    query: {
      instanceId: selectedInstanceId.value || undefined,
      bucket: selectedBucket.value || undefined,
      prefix: currentPrefix.value || undefined,
    },
  })
})

// 当 bucket 从 URL 初始化后，需要在 bucketList 加载完成后自动选中
watch([bucketList, selectedBucket], () => {
  // 深链恢复：bucketList 加载完成且未选中 bucket 时，从 pendingDeepLink 恢复
  if (pendingDeepLink.value?.bucket && bucketList.value.length && !selectedBucket.value) {
    const b = pendingDeepLink.value.bucket
    if (bucketList.value.includes(b)) {
      selectedBucket.value = b
    }
    else {
      // bucket 不在列表里（可能手动输入或已删），也设上以触发后续加载
      selectedBucket.value = b
    }
  }
})

// ---------- 上传对话框 ----------
const showUploadModal = ref(false)
const showSyncModal = ref(false)
const syncTaskActive = computed(() => sync.taskActive.value)
const syncCompletedCount = computed(() => sync.totalCompleted.value)
const syncTotalCount = computed(() => sync.totalCount.value)

// 页面标题
useHead({ title: '对象浏览 · miniops' })
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 页头 -->
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-bold text-highlighted">对象浏览</h1>
      <p class="text-muted">查看 MinIO 实例 bucket 中的对象，支持上传、下载与删除</p>
    </div>

    <!-- 1. 选实例 -->
    <div class="rounded-lg border border-default bg-default p-4">
      <h2 class="mb-3 font-semibold text-highlighted">1. 选择实例</h2>
      <NuxtSelectMenu
        v-model="selectedInstanceId"
        :items="instanceItems"
        value-key="value"
        placeholder="选择一个已启用的实例"
        class="w-full max-w-md"
      >
        <template #default>
          <span v-if="selectedInstance" class="truncate">{{ selectedInstance.name }} ({{ selectedInstance.endpoint }})</span>
          <span v-else class="text-muted">选择一个已启用的实例</span>
        </template>
      </NuxtSelectMenu>
    </div>

    <!-- 2. 选 Bucket -->
    <div
      class="rounded-lg border border-default bg-default p-4 transition-opacity"
      :class="{ 'opacity-50 pointer-events-none': !selectedInstanceId }"
    >
      <h2 class="mb-3 font-semibold text-highlighted">2. 选择 Bucket</h2>
      <div class="flex items-center gap-2">
        <NuxtIcon v-if="bucketLoading" name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
        <NuxtSelectMenu
          v-if="!bucketError && !bucketLoading"
          v-model="selectedBucket"
          :items="bucketList.map(b => ({ label: b, value: b }))"
          value-key="value"
          placeholder="选择 bucket"
          class="w-full max-w-md"
        >
          <template #default>
            <span v-if="selectedBucket" class="font-mono truncate">{{ selectedBucket }}</span>
            <span v-else class="text-muted">选择 bucket</span>
          </template>
        </NuxtSelectMenu>
        <!-- 加载失败：手动输入兜底 -->
        <template v-if="bucketError">
          <NuxtTooltip :text="bucketError">
            <NuxtIcon name="i-lucide-triangle-alert" class="size-4 text-warning shrink-0" />
          </NuxtTooltip>
          <NuxtInput
            v-model="bucketManualInput"
            placeholder="手动输入 bucket 名"
            class="w-full max-w-md"
            @update:model-value="(val: string) => selectedBucket = val"
          />
        </template>
        <span v-if="!bucketLoading && !bucketError && !bucketList.length && selectedInstanceId" class="text-sm text-muted">
          该实例无可用 bucket
        </span>
      </div>
    </div>

    <!-- 3. 浏览对象 -->
    <div
      class="rounded-lg border border-default bg-default p-4 transition-opacity"
      :class="{ 'opacity-50 pointer-events-none': !selectedBucket }"
    >
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="font-semibold text-highlighted">3. 浏览对象</h2>
        <div class="flex items-center gap-2">
          <NuxtInput
            v-model="prefixInput"
            placeholder="前缀跳转，如 config/2025Q3/"
            class="w-64"
            @keydown.enter="jumpToPrefix"
          />
          <NuxtButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-corner-down-right"
            label="跳转"
            @click="jumpToPrefix"
          />
          <NuxtButton
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            :loading="objectsLoading"
            @click="refresh"
          />
        </div>
      </div>

      <!-- 面包屑 -->
      <div class="mb-3 flex items-center gap-1 flex-wrap text-sm">
        <template v-for="(crumb, idx) in breadcrumbs" :key="idx">
          <NuxtButton
            size="xs"
            color="neutral"
            :variant="idx === breadcrumbs.length - 1 ? 'soft' : 'ghost'"
            :label="crumb.label"
            @click="navigateToBreadcrumb(idx)"
          />
          <NuxtIcon
            v-if="idx < breadcrumbs.length - 1"
            name="i-lucide-chevron-right"
            class="size-3 text-muted"
          />
        </template>
      </div>

      <!-- 工具栏：全选 + 批量操作 -->
      <div v-if="objects.length || commonPrefixes.length" class="mb-2 flex items-center gap-3">
        <NuxtCheckbox
          :model-value="isAllSelected"
          :indeterminate="isPartialSelected"
          @update:model-value="toggleSelectAll"
        />
        <span class="text-sm text-muted">
          已选 {{ selectedCount }}/{{ allSelectable.length }} 项
          <span v-if="selectedFolderCount > 0" class="text-warning">（含 {{ selectedFolderCount }} 个文件夹）</span>
        </span>
        <div class="flex-1" />
        <NuxtButton
          size="sm"
          color="primary"
          variant="outline"
          icon="i-lucide-upload"
          label="上传"
          :disabled="!selectedInstanceId || !selectedBucket"
          @click="showUploadModal = true; undefined"
        />
        <NuxtButton
          v-if="selectedCount > 0"
          size="sm"
          color="primary"
          variant="outline"
          icon="i-lucide-refresh-cw"
          label="同步到..."
          :disabled="syncTaskActive"
          @click="showSyncModal = true; undefined"
        />
        <NuxtButton
          v-if="selectedCount > 0"
          size="sm"
          color="info"
          variant="outline"
          icon="i-lucide-download"
          :label="`下载选中(${selectedCount})`"
          :loading="downloading"
          @click="downloadSelected"
        />
        <NuxtButton
          v-if="selectedCount > 0"
          size="sm"
          color="error"
          variant="outline"
          icon="i-lucide-trash-2"
          :label="`删除选中(${selectedCount})`"
          :loading="deleting"
          @click="deleteSelected"
        />
      </div>

      <!-- 加载中 -->
      <div v-if="objectsLoading" class="flex items-center gap-2 py-8 justify-center text-muted">
        <NuxtIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
        <span>加载中…</span>
      </div>

      <!-- 加载失败 -->
      <div v-else-if="objectsError" class="flex flex-col items-center gap-2 py-8">
        <NuxtIcon name="i-lucide-cloud-off" class="size-8 text-error" />
        <span class="text-error">{{ objectsError }}</span>
        <NuxtButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" label="重试" @click="refresh" />
      </div>

      <!-- 空状态 -->
      <div v-else-if="!objects.length && !commonPrefixes.length" class="flex flex-col items-center gap-2 py-12 text-muted">
        <NuxtIcon name="i-lucide-folder-open" class="size-10" />
        <span>该路径下暂无对象</span>
        <NuxtButton
          v-if="currentPrefix"
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-up"
          label="返回上一级"
          @click="navigateToBreadcrumb(breadcrumbs.length - 2)"
        />
      </div>

      <!-- 对象列表 -->
      <div v-else class="flex flex-col gap-0.5 select-none">
        <!-- 虚拟文件夹（CommonPrefixes） -->
        <div
          v-for="cp in commonPrefixes"
          :key="`cp-${cp}`"
          class="group flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-elevated"
        >
          <NuxtCheckbox
            :model-value="selectedPrefixes.has(cp)"
            @update:model-value="toggleSelectPrefix(cp)"
          />
          <div class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer" @click="navigateToPrefix(cp)">
            <NuxtIcon name="i-lucide-folder" class="size-4 shrink-0 text-primary" />
            <span class="font-mono truncate">{{ cp.replace(currentPrefix, '') }}</span>
          </div>
          <span class="text-muted text-xs shrink-0 w-20 text-right">-</span>
          <span class="text-muted text-xs shrink-0 w-36 text-right">-</span>
          <div class="w-24 shrink-0" />
        </div>

        <!-- 对象（Contents） -->
        <div
          v-for="obj in objects"
          :key="`obj-${obj.key}`"
          class="group flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-elevated"
          @dblclick="getPreviewType(obj.key) && openPreview(obj.key)"
        >
          <NuxtCheckbox
            :model-value="selectedKeys.has(obj.key)"
            @update:model-value="toggleSelect(obj.key)"
          />
          <NuxtIcon :name="fileIcon(obj.key)" class="size-4 shrink-0 text-muted" />
          <NuxtTooltip :text="obj.key">
            <span class="font-mono truncate flex-1">{{ displayName(obj.key) }}</span>
          </NuxtTooltip>
          <span class="text-muted text-xs shrink-0 w-20 text-right">{{ formatSize(obj.size) }}</span>
          <span class="text-muted text-xs shrink-0 w-36 text-right">{{ formatDate(obj.lastModified) }}</span>
          <div class="flex items-center gap-0.5 w-24 shrink-0 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
            <NuxtTooltip v-if="getPreviewType(obj.key)" text="预览">
              <NuxtButton
                size="xs"
                color="info"
                variant="ghost"
                icon="i-lucide-eye"
                @click="openPreview(obj.key)"
              />
            </NuxtTooltip>
            <NuxtTooltip text="下载">
              <NuxtButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-download"
                @click="downloadObject(obj.key)"
              />
            </NuxtTooltip>
            <NuxtTooltip text="复制下载链接">
              <NuxtButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-link"
                @click="copyPresignUrl(obj.key)"
              />
            </NuxtTooltip>
            <NuxtTooltip text="删除">
              <NuxtButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :loading="deleting"
                @click="deleteSingle(obj.key)"
              />
            </NuxtTooltip>
          </div>
        </div>

        <!-- 加载更多 -->
        <div v-if="continuationToken" class="flex justify-center pt-3">
          <NuxtButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-chevron-down"
            label="加载更多"
            :loading="loadingMore"
            @click="loadObjects(continuationToken)"
          />
        </div>
      </div>
    </div>

    <!-- 对象预览抽屉 -->
    <NuxtSlideover
      v-model:open="previewOpen"
      title="对象预览"
      side="right"
      :ui="{ content: 'w-full max-w-2xl sm:max-w-3xl' }"
    >
      <template #body>
        <div class="flex h-full flex-col gap-3">
          <!-- 顶部信息栏 -->
          <div class="flex items-start justify-between gap-4 border-b border-default pb-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <NuxtIcon :name="fileIcon(previewKey)" class="size-4 shrink-0 text-muted" />
                <span class="truncate font-mono font-medium text-highlighted">
                  {{ previewKey.split('/').pop() }}
                </span>
              </div>
              <div v-if="previewObject" class="mt-1 text-xs text-muted">
                {{ formatSize(previewObject.size) }} · {{ formatDate(previewObject.lastModified) }}
              </div>
              <div class="mt-0.5 text-xs text-muted">
                {{ selectedInstance?.name }} / {{ selectedBucket }}
              </div>
            </div>
            <NuxtButton
              size="sm"
              color="primary"
              variant="outline"
              icon="i-lucide-download"
              label="下载"
              @click="downloadObject(previewKey)"
            />
          </div>

          <!-- 内容区 -->
          <div class="flex-1 overflow-auto">
            <!-- 通用错误 -->
            <div v-if="previewError" class="flex flex-col items-center gap-2 py-12">
              <NuxtIcon name="i-lucide-cloud-off" class="size-8 text-error" />
              <span class="text-error">{{ previewError }}</span>
              <NuxtButton size="sm" color="neutral" variant="outline" label="关闭" @click="closePreview" />
            </div>

            <!-- 图片 -->
            <div v-else-if="previewType === 'image'" class="flex items-center justify-center min-h-75">
              <img
                :src="previewUrl"
                :alt="previewKey"
                class="max-h-[70vh] max-w-full object-contain"
                @error="onPreviewError"
              >
            </div>

            <!-- 视频 -->
            <div v-else-if="previewType === 'video'" class="flex items-center justify-center min-h-75">
              <video
                :src="previewUrl"
                controls
                preload="metadata"
                class="max-h-[70vh] max-w-full"
                @error="onPreviewError"
              >
                您的浏览器不支持视频播放
              </video>
            </div>

            <!-- 音频 -->
            <div v-else-if="previewType === 'audio'" class="flex flex-col items-center justify-center gap-4 py-12">
              <NuxtIcon name="i-lucide-music" class="size-16 text-primary" />
              <span class="text-sm text-muted">{{ previewKey.split('/').pop() }}</span>
              <audio :src="previewUrl" controls @error="onPreviewError">
                您的浏览器不支持音频播放
              </audio>
            </div>

            <!-- PDF -->
            <div v-else-if="previewType === 'pdf'">
              <iframe
                :src="previewUrl"
                class="h-[75vh] w-full border-0"
                :title="previewKey"
              />
              <p class="mt-2 text-center text-xs text-muted">PDF 预览不可用，请下载后查看</p>
            </div>

            <!-- 文本 -->
            <div v-else-if="previewType === 'text'">
              <!-- 加载中 -->
              <div v-if="textLoading" class="flex items-center justify-center py-12 text-muted">
                <NuxtIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
                <span class="ml-2">加载中…</span>
              </div>
              <!-- 错误 / 提示 -->
              <div v-else-if="textError" class="flex flex-col items-center gap-2 py-12">
                <NuxtIcon name="i-lucide-file-warning" class="size-8 text-warning" />
                <span class="text-warning text-center px-4">{{ textError }}</span>
                <NuxtButton
                  v-if="previewObject && previewObject.size <= TEXT_PREVIEW_LIMIT"
                  size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw"
                  label="重试" @click="fetchTextContent(previewKey)"
                />
              </div>
              <!-- 文本内容 -->
              <pre v-else class="text-xs font-mono whitespace-pre-wrap break-all bg-elevated rounded-md p-4 overflow-auto max-h-[70vh]"><code>{{ textContent }}</code></pre>
            </div>
          </div>
        </div>
      </template>
    </NuxtSlideover>

    <!-- 上传对话框 -->
    <BrowserUploadModal
      v-model:open="showUploadModal"
      :instance-id="selectedInstanceId"
      :instance-name="selectedInstance?.name ?? ''"
      :endpoint="selectedInstance?.endpoint ?? ''"
      :bucket="selectedBucket"
      :prefix="currentPrefix"
      @complete="loadObjects()"
    />

    <!-- 同步到其他实例对话框 -->
    <SyncTargetModal
      v-model:open="showSyncModal"
      :source-instance-id="selectedInstanceId"
      :source-instance-name="selectedInstance?.name ?? ''"
      :source-endpoint="selectedInstance?.endpoint ?? ''"
      :source-bucket="selectedBucket"
      :source-prefix="currentPrefix"
      :selected-keys="selectedKeys"
      :selected-prefixes="selectedPrefixes"
      :sync="sync"
      @complete="loadObjects()"
    />

    <!-- 悬浮进度指示器 -->
    <SyncFloatingIndicator
      v-if="syncTaskActive && !showSyncModal && sync.modalPhase.value !== 'select'"
      :is-running="sync.isRunning.value"
      :is-scanning="sync.isScanning.value"
      :scanned-count="sync.scannedCount.value"
      :task-summary="sync.taskSummary.value"
      :completed-count="syncCompletedCount"
      :total-count="syncTotalCount"
      @reopen="showSyncModal = true"
      @close="sync.reset()"
    />
  </div>
</template>
