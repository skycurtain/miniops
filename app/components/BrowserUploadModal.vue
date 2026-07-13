<script setup lang="ts">
/**
 * 对象浏览器上传对话框
 *
 * 底层复用「暂存 + dispatch + SSE」流水线，参数收窄为单实例：
 *   instanceIds=[当前实例] + bucket=当前bucket + prefix=当前浏览前缀
 *
 * 交互文档：docs/P0_DESIGN_13_BROWSER_UPLOAD.md
 * 技术方案：docs/P0_IMPL_13_BROWSER_UPLOAD.md
 */

// ---------- Props / Emits ----------

const props = defineProps<{
  open: boolean
  instanceId: string
  instanceName: string
  endpoint: string
  bucket: string
  /** 当前浏览前缀，如 "config/2025Q3/"，留空 = bucket 根 */
  prefix: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** 上传完成且有成功项时触发，父组件据刷新对象列表 */
  complete: []
}>()

const toast = useToast()

// ---------- 类型 ----------

interface StoredFile {
  id: string
  name: string
  objectKey: string
  size: number
  contentType: string
  storedPath: string
  uploadedAt: string
}

type ItemStatus = 'pending' | 'staging' | 'staged' | 'dispatching' | 'success' | 'failed'

interface UploadItem {
  /** StoredFile.id，暂存后填充；pending 阶段为空 */
  id: string
  name: string
  objectKey: string
  size: number
  contentType: string
  status: ItemStatus
  /** 暂存阶段 XHR 百分比 0-100 */
  progress: number
  error?: string
  /** 保留原始 File 引用用于暂存上传 */
  file: File
}

type Phase = 'select' | 'staging' | 'dispatching' | 'done'

// ---------- 状态 ----------

const items = ref<UploadItem[]>([])
const phase = ref<Phase>('select')
const summary = ref<{ total: number; success: number; failed: number } | null>(null)
let eventSource: EventSource | null = null

/** 当前正在进行的暂存 XHR，用于关闭时取消 */
let stagingXhrs: XMLHttpRequest[] = []

/** 取消标志：staging 阶段用户点「终止」时设为 true，for 循环检查后提前退出 */
let cancelled = false

// ---------- 工具函数 ----------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return 'i-lucide-file-image'
  if (['json'].includes(ext)) return 'i-lucide-file-json'
  if (['zip', 'gz', 'tar', 'tgz', 'rar', '7z'].includes(ext)) return 'i-lucide-file-archive'
  if (['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext)) return 'i-lucide-file-video'
  if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) return 'i-lucide-file-audio'
  if (['txt', 'csv', 'xml', 'log', 'md'].includes(ext)) return 'i-lucide-file-text'
  if (['js', 'ts', 'mjs', 'css', 'html', 'htm'].includes(ext)) return 'i-lucide-file-code'
  return 'i-lucide-file'
}

// ---------- 文件选择 ----------

function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return
  for (const file of Array.from(input.files)) {
    addPendingItem(file, file.name)
  }
  input.value = ''
}

function onFolderSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return
  for (const file of Array.from(input.files)) {
    // webkitRelativePath 保留目录结构，如 "myFolder/sub/a.json"
    const objectKey = file.webkitRelativePath || file.name
    addPendingItem(file, objectKey)
  }
  input.value = ''
}

function addPendingItem(file: File, objectKey: string) {
  // objectKey 去重：同批次选了同名文件，移除旧的 pending 项（保留最后一个）
  items.value = items.value.filter(i => !(i.objectKey === objectKey && i.status === 'pending'))

  items.value.push({
    id: '',
    name: file.name,
    objectKey,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
    status: 'pending',
    progress: 0,
    file,
  })
}

function removeItem(index: number) {
  const item = items.value[index]
  if (!item) return
  // 只允许移除 pending / failed 项
  if (item.status !== 'pending' && item.status !== 'failed') return
  items.value.splice(index, 1)
}

// ---------- 文件列表分组（单文件 + 文件夹聚合） ----------

interface FileGroup {
  type: 'file' | 'folder'
  folderName?: string
  items: UploadItem[]
  totalSize: number
}

const fileGroups = computed<FileGroup[]>(() => {
  const folderMap = new Map<string, UploadItem[]>()
  const singles: UploadItem[] = []

  for (const item of items.value) {
    const slashIdx = item.objectKey.indexOf('/')
    if (slashIdx > 0) {
      const folder = item.objectKey.slice(0, slashIdx)
      if (!folderMap.has(folder)) folderMap.set(folder, [])
      folderMap.get(folder)!.push(item)
    }
    else {
      singles.push(item)
    }
  }

  const groups: FileGroup[] = []
  for (const item of singles) {
    groups.push({ type: 'file', items: [item], totalSize: item.size })
  }
  for (const [folderName, groupItems] of folderMap) {
    groups.push({
      type: 'folder',
      folderName,
      items: groupItems,
      totalSize: groupItems.reduce((sum, i) => sum + i.size, 0),
    })
  }
  return groups
})

const folderExpanded = ref<Record<string, boolean>>({})

const totalCount = computed(() => items.value.length)
const pendingCount = computed(() => items.value.filter(i => i.status === 'pending').length)

/** 暂存阶段进度：staged/dispatching/success/failed 都算暂存完成 */
const stagingStats = computed(() => {
  const total = items.value.length
  const done = items.value.filter(i =>
    i.status === 'staged' || i.status === 'dispatching' || i.status === 'success' || i.status === 'failed',
  ).length
  return { done, total }
})

/** 分发阶段进度：只有 success/failed 算分发完成 */
const dispatchingStats = computed(() => {
  const total = items.value.length
  const done = items.value.filter(i => i.status === 'success' || i.status === 'failed').length
  return { done, total }
})

/** 文件夹聚合的状态图标 */
function folderStatusIcon(groupItems: UploadItem[]): { icon: string; class: string } | null {
  if (groupItems.some(i => i.status === 'staging' || i.status === 'dispatching')) {
    // 有活跃任务时按活跃类型选色：dispatching 优先（info 色），否则 staging（primary 色）
    const hasDispatching = groupItems.some(i => i.status === 'dispatching')
    return { icon: 'i-lucide-loader-circle', class: hasDispatching ? 'size-4 animate-spin text-info shrink-0' : 'size-4 animate-spin text-primary shrink-0' }
  }
  if (groupItems.some(i => i.status === 'failed')) {
    return { icon: 'i-lucide-x-circle', class: 'size-4 text-error shrink-0' }
  }
  if (groupItems.every(i => i.status === 'success')) {
    return { icon: 'i-lucide-check-circle', class: 'size-4 text-success shrink-0' }
  }
  // 全部 staged（已暂存等待分发）
  if (groupItems.every(i => i.status === 'staged')) {
    return { icon: 'i-lucide-clock', class: 'size-4 text-muted shrink-0' }
  }
  return null
}

/** 单文件状态展示 */
function itemStatusDisplay(item: UploadItem): { icon?: string; class?: string; text?: string; textClass?: string } {
  switch (item.status) {
    case 'pending':
      return { text: '等待中', textClass: 'text-xs text-muted shrink-0' }
    case 'staging':
      return { icon: 'i-lucide-loader-circle', class: 'size-3.5 animate-spin text-primary shrink-0', text: `${item.progress}%`, textClass: 'text-xs text-muted shrink-0' }
    case 'staged':
      return { icon: 'i-lucide-clock', class: 'size-3.5 text-muted shrink-0', text: '已暂存', textClass: 'text-xs text-muted shrink-0' }
    case 'dispatching':
      return { icon: 'i-lucide-loader-circle', class: 'size-3.5 animate-spin text-info shrink-0', text: '上传中', textClass: 'text-xs text-info shrink-0' }
    case 'success':
      return { icon: 'i-lucide-check-circle', class: 'size-3.5 text-success shrink-0' }
    case 'failed':
      return { icon: 'i-lucide-x-circle', class: 'size-3.5 text-error shrink-0', text: item.error || '失败', textClass: 'text-xs text-error shrink-0 truncate max-w-32' }
    default:
      return {}
  }
}

// ---------- 暂存上传 ----------

async function stageFile(item: UploadItem): Promise<StoredFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const form = new FormData()
    form.append('file', item.file)
    if (item.objectKey) form.append('objectKey', item.objectKey)

    stagingXhrs.push(xhr)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        item.progress = Math.round((e.loaded / e.total) * 100)
      }
    }
    xhr.onload = () => {
      stagingXhrs = stagingXhrs.filter(x => x !== xhr)
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        }
        catch {
          reject(new Error('响应解析失败'))
        }
      }
      else {
        reject(new Error(`HTTP ${xhr.status}`))
      }
    }
    xhr.onerror = () => {
      stagingXhrs = stagingXhrs.filter(x => x !== xhr)
      reject(new Error('网络错误'))
    }
    xhr.onabort = () => {
      stagingXhrs = stagingXhrs.filter(x => x !== xhr)
      reject(new Error('已取消'))
    }
    xhr.open('POST', '/api/uploads')
    xhr.send(form)
  })
}

// ---------- dispatch 提交 + SSE ----------

async function startUpload() {
  if (phase.value !== 'select') return

  // 1. 暂存所有 pending 文件
  phase.value = 'staging'
  const toStage = items.value.filter(i => i.status === 'pending')
  for (const item of toStage) {
    if (cancelled) break
    item.status = 'staging'
    item.progress = 0
    try {
      const stored = await stageFile(item)
      item.id = stored.id
      item.status = 'staged'
    }
    catch (e: any) {
      item.status = 'failed'
      item.error = e?.message || '暂存失败'
    }
  }

  // 用户终止：不提交 dispatch，已暂存的标记为 cancelled
  if (cancelled) {
    for (const item of items.value) {
      if (item.status === 'staged' || item.status === 'staging') {
        item.status = 'failed'
        item.error = '已取消'
      }
    }
    phase.value = 'done'
    summary.value = { total: items.value.length, success: 0, failed: items.value.length }
    return
  }

  // 2. 检查是否有成功暂存的文件
  const staged = items.value.filter(i => i.status === 'staged')
  if (!staged.length) {
    phase.value = 'done'
    summary.value = { total: items.value.length, success: 0, failed: items.value.length }
    return
  }

  // 3. 提交 dispatch（单实例 + bucket + prefix）
  phase.value = 'dispatching'
  for (const item of staged) item.status = 'dispatching'

  try {
    const res = await $fetch<{ taskId: string }>('/api/dispatch', {
      method: 'POST',
      body: {
        files: staged.map(i => ({ id: i.id, objectKey: i.objectKey })),
        instanceIds: [props.instanceId],
        groupIds: [],
        bucket: props.bucket,
        prefix: props.prefix || undefined,
      },
    })
    subscribeSSE(res.taskId)
  }
  catch (e: any) {
    // dispatch 提交失败，全部标记失败
    for (const item of staged) {
      item.status = 'failed'
      item.error = e?.data?.statusMessage || e?.message || '提交失败'
    }
    phase.value = 'done'
    summary.value = {
      total: items.value.length,
      success: items.value.filter(i => i.status === 'success').length,
      failed: items.value.filter(i => i.status === 'failed').length,
    }
  }
}

function subscribeSSE(taskId: string) {
  eventSource = new EventSource(`/api/dispatch/events?taskId=${taskId}`)

  eventSource.addEventListener('start', () => {
    // dispatching 状态保持，等待 progress
  })

  eventSource.addEventListener('progress', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    if (data.result) {
      // result.fileName = f.objectKey（不含 prefix）
      const item = items.value.find(i => i.objectKey === data.result.fileName)
      if (item) {
        item.status = data.result.status // 'success' | 'failed'
        item.error = data.result.error
      }
    }
  })

  eventSource.addEventListener('complete', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    summary.value = data.summary
    phase.value = 'done'

    // 兜底：未收到 progress 的 dispatching 项标记失败
    for (const item of items.value) {
      if (item.status === 'dispatching') {
        item.status = 'failed'
        item.error = '未收到结果'
      }
    }

    eventSource?.close()
    eventSource = null

    // 有成功项时通知父组件刷新
    if (data.summary?.success > 0) {
      emit('complete')
    }
  })

  eventSource.onerror = () => {
    if (phase.value === 'dispatching') {
      phase.value = 'done'
      for (const item of items.value) {
        if (item.status === 'dispatching') {
          item.status = 'failed'
          item.error = 'SSE 连接中断'
        }
      }
      summary.value = {
        total: items.value.length,
        success: items.value.filter(i => i.status === 'success').length,
        failed: items.value.filter(i => i.status === 'failed').length,
      }
      toast.add({ title: '连接中断', description: 'SSE 连接异常，进度可能不完整', color: 'error' })
    }
    eventSource?.close()
    eventSource = null
  }
}

// ---------- 对话框关闭 ----------

/** 终止：staging 阶段可用。abort 当前 XHR + 设取消标志停止后续循环。 */
function onCancel() {
  cancelled = true
  for (const xhr of stagingXhrs) {
    try { xhr.abort() } catch { /* 忽略 */ }
  }
  stagingXhrs = []
  toast.add({ title: '已终止上传', description: '未上传的文件已取消', color: 'info' })
}

// ---------- 浮窗指示器（后台运行时） ----------

/** 浮窗是否可见：Modal 关闭 + 任务在进行中或刚完成 */
const floatingVisible = computed(() => {
  return !props.open && (phase.value === 'staging' || phase.value === 'dispatching' || (phase.value === 'done' && floatingSummary.value))
})

/** 浮窗完成后自动淡出的摘要副本 */
const floatingSummary = ref<{ total: number; success: number; failed: number } | null>(null)
let floatingTimer: ReturnType<typeof setTimeout> | null = null

// phase 进入 done 时，复制 summary 到 floatingSummary，全部成功则 3s 后自动淡出
watch(() => phase.value, (val) => {
  if (val === 'done' && summary.value && !props.open) {
    floatingSummary.value = summary.value
    if (summary.value.failed === 0) {
      floatingTimer = setTimeout(() => {
        floatingSummary.value = null
      }, 3000)
    }
  }
})

onUnmounted(() => {
  if (floatingTimer) clearTimeout(floatingTimer)
})

function reopenModal() {
  floatingSummary.value = null
  if (floatingTimer) clearTimeout(floatingTimer)
  emit('update:open', true)
}

function closeFloating() {
  floatingSummary.value = null
  if (floatingTimer) clearTimeout(floatingTimer)
}

const floatingPercent = computed(() => {
  if (floatingSummary.value) return 100
  if (phase.value === 'staging') {
    return stagingStats.value.total ? Math.round(stagingStats.value.done / stagingStats.value.total * 100) : 0
  }
  const done = dispatchingStats.value.done
  const total = dispatchingStats.value.total
  return total ? Math.round(done / total * 100) : 0
})

/** 后台运行：关闭 Modal 但不中断任务。staging 阶段 XHR 继续，dispatching 阶段后端继续。 */
function onBackground() {
  emit('update:open', false)
}

/** done 阶段：正常关闭，重置状态。 */
function onClose() {
  emit('update:open', false)
}

// ---------- 对话框重新打开时重置 ----------

watch(() => props.open, (val) => {
  if (val) {
    // 仅在 done/select 阶段（非进行中）重置状态；进行中重开（如点浮窗）保留进度
    if (phase.value === 'done' || phase.value === 'select') {
      items.value = []
      phase.value = 'select'
      summary.value = null
      cancelled = false
      eventSource?.close()
      eventSource = null
      stagingXhrs = []
    }
  }
})

// ---------- 组件卸载清理 ----------

onUnmounted(() => {
  eventSource?.close()
  for (const xhr of stagingXhrs) {
    try { xhr.abort() } catch { /* 忽略 */ }
  }
})
</script>

<template>
  <NuxtModal
    :open="props.open"
    title="上传到对象存储"
    :dismissible="false"
    :close="phase === 'select' || phase === 'done'"
    :ui="{ content: 'max-w-2xl' }"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <!-- 目标上下文 -->
        <div class="rounded-md bg-elevated px-3 py-2 text-sm">
          <div class="flex items-center gap-2">
            <NuxtIcon name="i-lucide-server" class="size-4 shrink-0 text-muted" />
            <span class="text-highlighted">{{ props.instanceName }}</span>
            <span class="font-mono text-xs text-muted">{{ props.endpoint }}</span>
          </div>
          <div class="mt-1 flex items-center gap-2 text-muted">
            <span>Bucket: <span class="font-mono text-default">{{ props.bucket }}</span></span>
            <span>·</span>
            <span>前缀: <span class="font-mono text-default">{{ props.prefix || '（根目录）' }}</span></span>
          </div>
        </div>

        <!-- 选文件区（select / staging 阶段可见） -->
        <div v-if="phase === 'select'" class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <label class="cursor-pointer">
              <input type="file" multiple class="hidden" @change="onFilesSelected">
              <NuxtButton color="primary" variant="outline" icon="i-lucide-file-plus" label="添加文件" as="span" />
            </label>
            <label class="cursor-pointer">
              <input type="file" webkitdirectory directory multiple class="hidden" @change="onFolderSelected">
              <NuxtButton color="primary" variant="outline" icon="i-lucide-folder-plus" label="添加文件夹" as="span" />
            </label>
          </div>

          <!-- 文件列表 -->
          <div v-if="items.length" class="flex flex-col gap-1.5">
            <template v-for="(group, gi) in fileGroups" :key="gi">
              <!-- 文件夹聚合 -->
              <div v-if="group.type === 'folder'" class="rounded-md border border-default bg-elevated">
                <div class="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <button class="shrink-0" @click="folderExpanded[group.folderName!] = !folderExpanded[group.folderName!]">
                    <NuxtIcon :name="folderExpanded[group.folderName!] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-muted" />
                  </button>
                  <NuxtIcon name="i-lucide-folder" class="size-4 shrink-0 text-primary" />
                  <span class="font-mono truncate flex-1">{{ group.folderName }}/</span>
                  <span class="text-muted text-xs shrink-0">{{ group.items.length }} 个文件</span>
                  <span class="text-muted text-xs shrink-0">{{ formatSize(group.totalSize) }}</span>
                </div>
                <div v-if="folderExpanded[group.folderName!]" class="border-t border-default flex flex-col gap-0.5 px-3 py-1">
                  <div v-for="item in group.items" :key="item.objectKey" class="flex items-center gap-2 py-0.5 text-sm pl-6">
                    <NuxtIcon :name="fileIcon(item.name)" class="size-3.5 shrink-0 text-muted" />
                    <span class="font-mono truncate flex-1 text-xs text-muted">{{ item.objectKey }}</span>
                    <span class="text-muted text-xs shrink-0">{{ formatSize(item.size) }}</span>
                  </div>
                </div>
              </div>
              <!-- 单文件 -->
              <div v-else class="flex items-center gap-2 rounded-md border border-default bg-elevated px-3 py-1.5 text-sm">
                <template v-for="item in group.items" :key="item.objectKey">
                  <NuxtIcon :name="fileIcon(item.name)" class="size-4 shrink-0 text-primary" />
                  <span class="font-mono truncate flex-1">{{ item.objectKey }}</span>
                  <span class="text-muted text-xs shrink-0">{{ formatSize(item.size) }}</span>
                  <button class="text-muted hover:text-error shrink-0" @click="removeItem(items.indexOf(item))">
                    <NuxtIcon name="i-lucide-x" class="size-3.5" />
                  </button>
                </template>
              </div>
            </template>
          </div>

          <!-- 空状态 -->
          <div v-else class="flex items-center gap-2 py-6 text-muted">
            <NuxtIcon name="i-lucide-inbox" class="size-5" />
            <span>点击"添加文件"或"添加文件夹"选择要上传的文件</span>
          </div>
        </div>

        <!-- 上传进度（staging / dispatching / done 阶段） -->
        <div v-if="phase !== 'select'" class="flex flex-col gap-3">
          <!-- 双阶段进度条 -->
          <div v-if="phase !== 'done'" class="flex flex-col gap-2">
            <!-- 阶段 1：暂存 -->
            <div class="flex items-center gap-3">
              <span class="text-sm shrink-0 w-16" :class="phase === 'staging' ? 'text-primary font-medium' : (phase === 'dispatching' ? 'text-success' : 'text-muted')">
                <NuxtIcon v-if="phase === 'dispatching'" name="i-lucide-check-circle" class="size-3.5 inline-block" />
                暂存
              </span>
              <div class="flex-1 h-2 rounded-full bg-elevated overflow-hidden">
                <div
                  class="h-full transition-all duration-300"
                  :class="phase === 'dispatching' ? 'bg-success' : 'bg-primary'"
                  :style="{ width: `${stagingStats.total ? (stagingStats.done / stagingStats.total) * 100 : 0}%` }"
                />
              </div>
              <span class="text-sm text-muted shrink-0 w-12 text-right">{{ stagingStats.done }}/{{ stagingStats.total }}</span>
            </div>
            <!-- 阶段 2：上传 -->
            <div class="flex items-center gap-3">
              <span class="text-sm shrink-0 w-16" :class="phase === 'dispatching' ? 'text-primary font-medium' : 'text-muted'">
                上传
              </span>
              <div class="flex-1 h-2 rounded-full bg-elevated overflow-hidden">
                <div
                  v-if="phase === 'dispatching'"
                  class="h-full bg-primary transition-all duration-300"
                  :style="{ width: `${dispatchingStats.total ? (dispatchingStats.done / dispatchingStats.total) * 100 : 0}%` }"
                />
              </div>
              <span class="text-sm text-muted shrink-0 w-12 text-right">{{ phase === 'dispatching' ? `${dispatchingStats.done}/${dispatchingStats.total}` : '等待中' }}</span>
            </div>
          </div>

          <!-- 文件级状态列表 -->
          <div class="flex flex-col gap-1 max-h-64 overflow-auto">
            <template v-for="(group, gi) in fileGroups" :key="gi">
              <!-- 文件夹聚合 -->
              <div v-if="group.type === 'folder'" class="rounded-md border border-default bg-elevated">
                <div class="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <button class="shrink-0" @click="folderExpanded[group.folderName!] = !folderExpanded[group.folderName!]">
                    <NuxtIcon :name="folderExpanded[group.folderName!] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-muted" />
                  </button>
                  <NuxtIcon name="i-lucide-folder" class="size-4 shrink-0 text-primary" />
                  <span class="font-mono truncate flex-1">{{ group.folderName }}/</span>
                  <span class="text-muted text-xs shrink-0">{{ group.items.length }} 个文件</span>
                  <template v-if="folderStatusIcon(group.items)">
                    <NuxtIcon :name="folderStatusIcon(group.items)!.icon" :class="folderStatusIcon(group.items)!.class" />
                  </template>
                </div>
                <div v-if="folderExpanded[group.folderName!]" class="border-t border-default flex flex-col gap-0.5 px-3 py-1">
                  <div v-for="item in group.items" :key="item.objectKey" class="flex items-center gap-2 py-0.5 text-sm pl-6">
                    <NuxtIcon :name="fileIcon(item.name)" class="size-3.5 shrink-0 text-muted" />
                    <span class="font-mono truncate flex-1 text-xs text-muted">{{ item.objectKey }}</span>
                    <span class="text-muted text-xs shrink-0">{{ formatSize(item.size) }}</span>
                    <template v-if="itemStatusDisplay(item).icon">
                      <NuxtIcon :name="itemStatusDisplay(item).icon" :class="itemStatusDisplay(item).class" />
                    </template>
                    <span v-if="itemStatusDisplay(item).text" :class="itemStatusDisplay(item).textClass">{{ itemStatusDisplay(item).text }}</span>
                  </div>
                </div>
              </div>
              <!-- 单文件 -->
              <div v-else class="flex items-center gap-2 rounded-md border border-default bg-elevated px-3 py-1.5 text-sm">
                <template v-for="item in group.items" :key="item.objectKey">
                  <NuxtIcon :name="fileIcon(item.name)" class="size-4 shrink-0 text-primary" />
                  <span class="font-mono truncate flex-1">{{ item.objectKey }}</span>
                  <span class="text-muted text-xs shrink-0">{{ formatSize(item.size) }}</span>
                  <template v-if="itemStatusDisplay(item).icon">
                    <NuxtIcon :name="itemStatusDisplay(item).icon" :class="itemStatusDisplay(item).class" />
                  </template>
                  <span v-if="itemStatusDisplay(item).text" :class="itemStatusDisplay(item).textClass">{{ itemStatusDisplay(item).text }}</span>
                </template>
              </div>
            </template>
          </div>

          <!-- 完成汇总 -->
          <div v-if="phase === 'done' && summary" class="rounded-md border border-default px-3 py-2 text-sm" :class="summary.failed > 0 ? 'border-warning bg-warning/5' : 'border-success bg-success/5'">
            共 {{ summary.total }} 项，成功 {{ summary.success }}，失败 {{ summary.failed }}
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <!-- select 阶段：取消 + 开始上传 -->
        <template v-if="phase === 'select'">
          <NuxtButton color="neutral" variant="ghost" label="取消" @click="onClose" />
          <NuxtButton
            color="primary"
            icon="i-lucide-upload"
            label="开始上传"
            :disabled="!items.length"
            @click="startUpload"
          />
        </template>
        <!-- staging 阶段：终止 + 后台运行 -->
        <template v-else-if="phase === 'staging'">
          <NuxtButton color="error" variant="ghost" icon="i-lucide-x" label="终止" @click="onCancel" />
          <NuxtButton color="neutral" variant="ghost" icon="i-lucide-arrow-down-to-line" label="后台运行" @click="onBackground" />
        </template>
        <!-- dispatching 阶段：后台运行（后端任务不可取消） -->
        <template v-else-if="phase === 'dispatching'">
          <NuxtButton color="neutral" variant="ghost" icon="i-lucide-arrow-down-to-line" label="后台运行" @click="onBackground" />
        </template>
        <!-- done 阶段：关闭 -->
        <template v-else>
          <NuxtButton color="primary" label="关闭" @click="onClose" />
        </template>
      </div>
    </template>
  </NuxtModal>

  <!-- 悬浮进度指示器（后台运行时） -->
  <div
    v-if="floatingVisible"
    class="fixed bottom-4 right-4 z-50 cursor-pointer"
    @click="reopenModal"
  >
    <div class="rounded-lg border border-default bg-default shadow-lg p-3 min-w-52 transition-all hover:shadow-xl">
      <!-- 进行中 -->
      <div v-if="phase === 'staging' || phase === 'dispatching'" class="flex flex-col gap-1.5">
        <div class="flex items-center gap-2">
          <NuxtIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary shrink-0" />
          <span class="text-sm font-medium">
            {{ phase === 'staging' ? '暂存中' : '上传中' }}
            {{ phase === 'staging' ? `${stagingStats.done}/${stagingStats.total}` : `${dispatchingStats.done}/${dispatchingStats.total}` }}
          </span>
        </div>
        <NuxtProgress :model-value="floatingPercent" size="sm" />
      </div>
      <!-- 全部成功 -->
      <div v-else-if="floatingSummary && floatingSummary.failed === 0" class="flex items-center gap-2">
        <NuxtIcon name="i-lucide-check-circle" class="size-4 text-success shrink-0" />
        <span class="text-sm font-medium text-success">上传完成 {{ floatingSummary.total }}/{{ floatingSummary.total }}</span>
      </div>
      <!-- 有失败 -->
      <div v-else-if="floatingSummary" class="flex items-center gap-2">
        <NuxtIcon name="i-lucide-triangle-alert" class="size-4 text-warning shrink-0" />
        <span class="text-sm font-medium text-warning">完成 {{ floatingSummary.success }}/{{ floatingSummary.total }}，{{ floatingSummary.failed }} 失败</span>
        <button class="ml-1 text-muted hover:text-error shrink-0" @click.stop="closeFloating">
          <NuxtIcon name="i-lucide-x" class="size-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
