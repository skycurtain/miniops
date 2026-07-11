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

/** 整体进度（staging + dispatching 阶段） */
const progressStats = computed(() => {
  const total = items.value.length
  const done = items.value.filter(i => i.status === 'success' || i.status === 'failed').length
  return { done, total }
})

/** 文件夹聚合的状态图标 */
function folderStatusIcon(groupItems: UploadItem[]): { icon: string; class: string } | null {
  if (groupItems.some(i => i.status === 'staging' || i.status === 'dispatching')) {
    return { icon: 'i-lucide-loader-circle', class: 'size-4 animate-spin text-primary shrink-0' }
  }
  if (groupItems.some(i => i.status === 'failed')) {
    return { icon: 'i-lucide-x-circle', class: 'size-4 text-error shrink-0' }
  }
  if (groupItems.every(i => i.status === 'success')) {
    return { icon: 'i-lucide-check-circle', class: 'size-4 text-success shrink-0' }
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
      return { icon: 'i-lucide-loader-circle', class: 'size-3.5 animate-spin text-primary shrink-0' }
    case 'dispatching':
      return { icon: 'i-lucide-loader-circle', class: 'size-3.5 animate-spin text-primary shrink-0', text: '上传中', textClass: 'text-xs text-muted shrink-0' }
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

function onClose() {
  // staging 阶段：取消未完成的暂存请求
  if (phase.value === 'staging') {
    for (const xhr of stagingXhrs) {
      try { xhr.abort() } catch { /* 忽略 */ }
    }
    stagingXhrs = []
  }

  // dispatching 阶段：后端任务继续跑，不中断
  if (phase.value === 'dispatching') {
    toast.add({
      title: '上传任务在后台继续',
      description: '关闭不会中断，完成后可刷新列表查看',
      color: 'info',
    })
  }

  eventSource?.close()
  eventSource = null
  emit('update:open', false)
}

// ---------- 对话框重新打开时重置 ----------

watch(() => props.open, (val) => {
  if (val) {
    items.value = []
    phase.value = 'select'
    summary.value = null
    eventSource?.close()
    eventSource = null
    stagingXhrs = []
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
          <!-- 整体进度条 -->
          <div v-if="phase !== 'done'" class="flex items-center gap-3">
            <span class="text-sm text-muted shrink-0">
              {{ phase === 'staging' ? '正在暂存' : '正在上传' }}...
            </span>
            <div class="flex-1 h-2 rounded-full bg-elevated overflow-hidden">
              <div
                class="h-full bg-primary transition-all duration-300"
                :style="{ width: `${progressStats.total ? (progressStats.done / progressStats.total) * 100 : 0}%` }"
              />
            </div>
            <span class="text-sm text-muted shrink-0 w-12 text-right">{{ progressStats.done }}/{{ progressStats.total }}</span>
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
        <!-- staging / dispatching 阶段：只显示关闭（带提示） -->
        <template v-else-if="phase === 'staging' || phase === 'dispatching'">
          <NuxtButton color="neutral" variant="ghost" label="关闭" @click="onClose" />
        </template>
        <!-- done 阶段：关闭 -->
        <template v-else>
          <NuxtButton color="primary" label="关闭" @click="onClose" />
        </template>
      </div>
    </template>
  </NuxtModal>
</template>
