<script setup lang="ts">
/**
 * 上传弹窗（统一任务架构改造后）
 *
 * 两阶段：
 * 1. 暂存（staging）：XHR 逐文件 POST /api/browse/objects/stage 落盘后端，
 *    弹窗不可关（前端 XHR，关闭即中断）
 * 2. 上传（uploading）：POST /api/browse/objects/upload 提交任务拿 taskId，
 *    useTaskManager 订阅 SSE 进度；弹窗可关（后台继续，任务查看器全局可见）
 *
 * 完成态显示扁平 fileProgress 结果列表，支持重试失败项（重新暂存 + 新任务）。
 */

import { formatSize, fileIcon } from '~/utils/browse'
import type { TaskState } from '#shared/schemas/task'

interface UploadItem {
  id: string
  file: File
  name: string
  relativePath: string
  size: number
  status: 'pending' | 'uploading' | 'success' | 'failed'
  progress: number
  error?: string
  fileId?: string
}

/** 待上传列表分组（与分发页 file-list 同构）：文件夹聚合 + 散文件单条 */
interface ItemGroup {
  type: 'file' | 'folder'
  folderName?: string
  items: UploadItem[]
  totalSize: number
}

type Phase = 'select' | 'staging' | 'uploading' | 'done'

const props = defineProps<{
  open: boolean
  instanceId: string
  instanceName: string
  bucket: string
  prefix: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  complete: []
}>()

const toast = useToast()
const taskManager = useTaskManager()

const items = ref<UploadItem[]>([])
const phase = ref<Phase>('select')
const fileInput = ref<HTMLInputElement>()
const folderInput = ref<HTMLInputElement>()

// ==================== 选择文件 ====================

function triggerSelectFiles() {
  fileInput.value?.click()
}

function triggerSelectFolder() {
  folderInput.value?.click()
}

function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return
  addFiles(input.files)
  input.value = ''
}

function addFiles(fileList: FileList) {
  for (const file of Array.from(fileList)) {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    items.value.push({
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      name: file.name,
      relativePath,
      size: file.size,
      status: 'pending',
      progress: 0,
    })
  }
}

function removeItem(id: string) {
  items.value = items.value.filter((i) => i.id !== id)
}

// ==================== 待上传列表分组（文件夹聚合，对齐分发页 file-list） ====================

/** 相对路径的顶层文件夹名（无文件夹层返回 undefined） */
function folderNameOf(relativePath: string): string | undefined {
  const parts = relativePath.split('/')
  return parts.length > 1 ? parts[0] : undefined
}

const itemGroups = computed<ItemGroup[]>(() => {
  const groupMap = new Map<string, UploadItem[]>()
  const standalone: UploadItem[] = []
  for (const item of items.value) {
    const folder = folderNameOf(item.relativePath)
    if (folder) {
      if (!groupMap.has(folder)) groupMap.set(folder, [])
      groupMap.get(folder)!.push(item)
    } else {
      standalone.push(item)
    }
  }
  const result: ItemGroup[] = []
  for (const [folderName, groupItems] of groupMap) {
    result.push({
      type: 'folder',
      folderName,
      items: groupItems,
      totalSize: groupItems.reduce((s, i) => s + i.size, 0),
    })
  }
  for (const item of standalone) {
    result.push({ type: 'file', items: [item], totalSize: item.size })
  }
  return result
})

/** 文件夹折叠状态（默认折叠） */
const folderExpanded = ref<Record<string, boolean>>({})

/** 整组移除（文件夹聚合条目的 × 按钮） */
function removeGroup(group: ItemGroup) {
  const ids = new Set(group.items.map(i => i.id))
  items.value = items.value.filter(i => !ids.has(i.id))
}

// ==================== 暂存阶段（XHR 逐文件） ====================

let stagingCancelled = false
let currentXhr: XMLHttpRequest | null = null

/** 暂存进度总览（正在暂存的文件百分比均值） */
const stagingPercent = computed(() => {
  const uploading = items.value.filter(i => i.status === 'uploading' || i.status === 'success')
  if (!uploading.length) return 0
  const sum = items.value.reduce((s, i) => {
    if (i.status === 'uploading') return s + i.progress
    if (i.status === 'success') return s + 100
    return s
  }, 0)
  return Math.round(sum / uploading.length)
})

/** 用 XMLHttpRequest 暂存单个文件（需要 upload.onprogress 真实进度） */
function stageSingleFile(item: UploadItem): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const formData = new FormData()
    formData.append('objectKey', item.relativePath)
    // originalName 显式传：Bun 对非 ASCII multipart filename 解析有缺陷（file.name 为 undefined）
    formData.append('originalName', item.name)
    formData.append('file', item.file, item.name)

    const xhr = new XMLHttpRequest()
    currentXhr = xhr

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        item.progress = (e.loaded / e.total) * 100
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const res = JSON.parse(xhr.responseText) as { fileId: string }
          item.fileId = res.fileId
          resolve()
        } catch {
          reject(new Error('响应解析失败'))
        }
      } else {
        let msg = `暂存失败 (${xhr.status})`
        try {
          const err = JSON.parse(xhr.responseText)
          msg = err.message || msg
        } catch {
          // 非 JSON 错误响应
        }
        reject(new Error(msg))
      }
    })

    xhr.addEventListener('error', () => reject(new Error('网络错误')))
    xhr.addEventListener('abort', () => reject(new Error('已取消')))

    xhr.open('POST', '/api/browse/objects/stage')
    xhr.send(formData)
  }).finally(() => {
    currentXhr = null
  })
}

// ==================== 上传阶段（useTaskManager） ====================

/** 当前任务 ID */
const currentTaskId = ref<string | null>(null)

/** 从 useTaskManager 全局状态匹配当前任务 */
const currentTask = computed<TaskState | null>(() => {
  if (!currentTaskId.value) return null
  const inActive = taskManager.activeTasks.value.find(t => t.taskId === currentTaskId.value)
  if (inActive) return inActive
  const inQueue = taskManager.queueTasks.value.find(t => t.taskId === currentTaskId.value)
  if (inQueue) return inQueue
  return taskManager.completedTasks.value.find(t => t.taskId === currentTaskId.value) ?? null
})

/** 任务状态 */
const taskStatus = computed(() => currentTask.value?.status ?? 'queued')

/** 文件列表从 fileProgress.results 渲染（扁平结构） */
const progressItems = computed(() => {
  const results = currentTask.value?.fileProgress?.results ?? {}
  return Object.entries(results).map(([key, result]) => ({
    key,
    name: key.split('/').pop() ?? key,
    status: result.status,
    error: result.error,
    duration: result.duration,
  }))
})

const summary = computed(() => currentTask.value?.summary ?? null)

const isRunning = computed(() =>
  taskStatus.value === 'queued' || taskStatus.value === 'running',
)

/** 队列位置 */
const queuePosition = computed(() => currentTask.value?.queuePosition ?? null)

const failedCount = computed(() => summary.value?.failed ?? 0)

// ==================== 提交执行 ====================

/** 任务终态是否已通知父组件刷新（避免重复） */
let completeEmitted = false

/**
 * 最近一次提交的任务 ID（不受弹窗重开影响）。
 * 后台继续后重开弹窗会清空 currentTaskId，导致 watch(taskStatus) 感知不到
 * 旧任务终态；用此引用从 completedTasks 里兜底捕获终态，保证刷新不丢。
 */
let lastTaskRef: { taskId: string } | null = null

async function startUpload() {
  stagingCancelled = false
  phase.value = 'staging'

  // 1. 逐文件暂存（失败标记 ❌，不影响其他文件）
  const pending = items.value.filter((i) => i.status === 'pending' || i.status === 'failed')
  for (const item of pending) {
    if (stagingCancelled) return
    item.status = 'uploading'
    item.progress = 0
    item.error = undefined

    try {
      await stageSingleFile(item)
      item.status = 'success'
      item.progress = 100
    } catch (e: unknown) {
      if (stagingCancelled) return
      item.status = 'failed'
      item.error = e instanceof Error ? e.message : '暂存失败'
    }
  }
  if (stagingCancelled) return

  // 2. 有暂存失败的文件：停在 staging 视图（文件列表带 ❌），可重试或关闭
  if (items.value.some(i => i.status === 'failed')) {
    phase.value = 'done'
    toast.add({
      title: '部分文件暂存失败',
      description: '可点击「重试失败项」重新暂存',
      color: 'warning',
    })
    return
  }

  // 3. 提交上传任务
  await submitUploadTask()
}

/** 提交上传任务（暂存已全部成功；重试失败项复用） */
async function submitUploadTask() {
  const files = items.value
    .filter(i => i.fileId)
    .map(i => ({ fileId: i.fileId!, objectKey: i.relativePath }))

  try {
    const { taskId } = await $fetch<{ taskId: string }>('/api/browse/objects/upload', {
      method: 'POST',
      body: {
        files,
        instanceId: props.instanceId,
        bucket: props.bucket,
        prefix: props.prefix,
      },
    })
    currentTaskId.value = taskId
    lastTaskRef = { taskId }
    completeEmitted = false
    phase.value = 'uploading'
    await taskManager.subscribeTask(taskId)
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    toast.add({
      title: '提交上传任务失败',
      description: err?.data?.message || err?.message || '未知错误',
      color: 'error',
    })
    phase.value = 'done'
  }
}

// ==================== 完成/取消/后台继续 ====================

watch(taskStatus, (status) => {
  if (status === 'done' || status === 'cancelled' || status === 'failed') {
    phase.value = 'done'
    if (!completeEmitted) {
      completeEmitted = true
      emit('complete')
    }
    const s = summary.value
    if (status === 'cancelled') {
      const parts = ['已取消']
      if (s) {
        parts.push(`${s.success} 成功`)
        if (s.failed > 0) parts.push(`${s.failed} 失败`)
        if (s.skipped > 0) parts.push(`${s.skipped} 跳过`)
      }
      toast.add({ title: `上传${parts.join('，')}`, color: 'warning' })
    } else if (s) {
      if (s.failed > 0) {
        toast.add({
          title: `上传完成：${s.success} 成功，${s.failed} 失败`,
          color: 'warning',
        })
      } else {
        toast.add({ title: `上传完成：${s.success} 个文件`, color: 'success' })
      }
    } else if (status === 'failed') {
      toast.add({ title: '上传失败', color: 'error' })
    }
  }
})

/**
 * 兜底：后台继续后重开弹窗（currentTaskId 被清空）导致主 watch 失效时，
 * 从 completedTasks 捕获 lastTaskRef 任务的终态，补发刷新。
 */
watch(() => taskManager.completedTasks.value, (tasks) => {
  if (!lastTaskRef || completeEmitted) return
  const done = tasks.find(t => t.taskId === lastTaskRef!.taskId)
  if (!done) return
  completeEmitted = true
  emit('complete')
}, { deep: true })

/** 后台继续：关闭弹窗，任务在后端继续，任务查看器全局可见 */
function backgroundContinue() {
  emit('update:open', false)
}

/** 从弹窗取消任务（排队中取消不会触发 SSE 事件，需手动处理弹窗状态） */
async function cancelUpload() {
  if (!currentTaskId.value) return
  const wasQueued = taskStatus.value === 'queued'
  await taskManager.cancelTask(currentTaskId.value)
  if (wasQueued) {
    // 排队取消后端不 emit cancelled，弹窗需要手动切换到完成态
    phase.value = 'done'
    toast.add({ title: '上传已取消', color: 'warning' })
  }
  // running 取消：保留 SSE，等 cancelled 事件由 watch(taskStatus) 更新终态与文件状态
}

/** 暂存阶段取消：中止当前 XHR，回到 select（已暂存文件由后端 TTL 清理） */
function cancelStaging() {
  stagingCancelled = true
  currentXhr?.abort()
  currentXhr = null
  phase.value = 'select'
  for (const item of items.value) {
    if (item.status === 'uploading' || item.status === 'pending') {
      item.status = 'pending'
      item.progress = 0
      item.fileId = undefined
    }
  }
}

/** 重试失败项：暂存失败的回到暂存；上传失败的重新暂存 + 新任务 */
async function retryFailed() {
  // 暂存失败 + 上传失败的 objectKey
  const uploadFailedKeys = new Set(progressItems.value.filter(i => i.status === 'failed').map(i => i.key))

  for (const item of items.value) {
    if (item.status === 'failed' || uploadFailedKeys.has(item.relativePath)) {
      item.status = 'pending'
      item.progress = 0
      item.error = undefined
      item.fileId = undefined
    }
  }

  // 只剩失败项需要走流程，清掉已成功的
  items.value = items.value.filter(i => i.status === 'pending')
  currentTaskId.value = null

  await startUpload()
}

function onClose() {
  if (phase.value === 'done' && !completeEmitted) {
    // 暂存失败停留 done 视图时也可能已有成功文件（无 fileProgress，用 items 判断）
    const uploadedAny = summary.value
      ? (summary.value.success ?? 0) > 0
      : items.value.some(i => i.status === 'success' && i.fileId)
    if (uploadedAny) {
      completeEmitted = true
      emit('complete')
    }
  }
  emit('update:open', false)
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      items.value = []
      phase.value = 'select'
      currentTaskId.value = null
      completeEmitted = false
    }
  },
)

// 组件卸载时中止进行中的暂存 XHR
onBeforeUnmount(() => {
  if (phase.value === 'staging') {
    stagingCancelled = true
    currentXhr?.abort()
  }
})

// ==================== 展示辅助 ====================

const targetPath = computed(() => {
  const parts = [props.instanceName, props.bucket]
  if (props.prefix) parts.push(props.prefix)
  return parts.join(' / ')
})

/** 弹窗关闭按钮（非 dismissible 路径）：仅 staging 阶段禁止 */
const canClose = computed(() => phase.value !== 'staging')

/** 任务进度列表的目录层级缩进（fileProgress key 带相对路径） */
function indentLevel(relativePath: string): number {
  const parts = relativePath.split('/')
  return parts.length > 1 ? parts.length - 1 : 0
}
</script>

<template>
  <NuxtModal
    :open="open"
    :title="`上传到：${targetPath}`"
    :dismissible="false"
    :close="canClose"
    :ui="{ content: 'w-[calc(100vw-2rem)] max-w-2xl' }"
    @update:open="(v: boolean) => { if (!v && !canClose) return; if (!v) onClose(); else emit('update:open', v) }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <!-- 选择文件按钮（select 阶段） -->
        <div v-if="phase === 'select'" class="flex gap-2">
          <NuxtButton
            color="primary"
            variant="outline"
            icon="i-lucide-file-plus"
            label="选择文件"
            @click="triggerSelectFiles"
          />
          <NuxtButton
            color="primary"
            variant="outline"
            icon="i-lucide-folder-plus"
            label="选择文件夹"
            @click="triggerSelectFolder"
          />
        </div>

        <!-- 隐藏的文件输入 -->
        <input ref="fileInput" type="file" multiple class="hidden" @change="onFilesSelected" />
        <input
          ref="folderInput"
          type="file"
          multiple
          webkitdirectory
          class="hidden"
          @change="onFilesSelected"
        />

        <!-- select / staging 阶段：待上传列表（文件夹聚合，对齐分发页） -->
        <div v-if="items.length && (phase === 'select' || phase === 'staging' || (phase === 'done' && !currentTaskId))" class="flex flex-col gap-2">
          <div class="text-muted text-sm font-medium">
            {{ phase === 'staging' ? '暂存中：' : '待上传列表：' }}
          </div>
          <div class="bg-elevated max-h-80 overflow-y-auto rounded-md p-2">
            <div class="flex flex-col gap-1.5">
              <template v-for="(group, gi) in itemGroups" :key="gi">
                <!-- 文件夹聚合条目 -->
                <div v-if="group.type === 'folder'" class="border-default bg-default rounded-md border">
                  <div class="group/row flex items-center gap-2 px-3 py-1.5 text-sm">
                    <button
                      class="flex shrink-0 items-center"
                      @click="folderExpanded[group.folderName!] = !folderExpanded[group.folderName!]"
                    >
                      <NuxtIcon
                        :name="folderExpanded[group.folderName!] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                        class="text-muted size-4"
                      />
                    </button>
                    <NuxtIcon name="i-lucide-folder" class="text-primary size-4 shrink-0" />
                    <span class="truncate flex-1 font-mono">{{ group.folderName }}/</span>
                    <span class="text-muted shrink-0 text-xs">{{ group.items.length }} 个文件</span>
                    <span class="text-muted shrink-0 text-xs">{{ formatSize(group.totalSize) }}</span>

                    <!-- 组状态（暂存阶段聚合展示） -->
                    <NuxtIcon
                      v-if="group.items.some(i => i.status === 'uploading')"
                      name="i-lucide-loader-circle"
                      class="text-primary size-4 shrink-0 animate-spin"
                    />
                    <NuxtIcon
                      v-else-if="group.items.some(i => i.status === 'failed')"
                      name="i-lucide-x-circle"
                      class="text-error size-4 shrink-0"
                    />
                    <NuxtIcon
                      v-else-if="group.items.every(i => i.status === 'success')"
                      name="i-lucide-check-circle"
                      class="text-success size-4 shrink-0"
                    />

                    <!-- 整组移除（仅 select 阶段） -->
                    <button
                      v-if="phase === 'select'"
                      class="flex shrink-0 items-center text-muted hover:text-error"
                      @click="removeGroup(group)"
                    >
                      <NuxtIcon name="i-lucide-x" class="size-3.5" />
                    </button>
                  </div>
                  <!-- 展开的文件明细 -->
                  <div
                    v-if="folderExpanded[group.folderName!]"
                    class="border-default flex flex-col border-t px-3 py-1"
                  >
                    <div
                      v-for="item in group.items"
                      :key="item.id"
                      class="group/item flex items-center gap-2 py-0.5 pl-6 text-sm"
                    >
                      <NuxtIcon name="i-lucide-file" class="text-muted size-3.5 shrink-0" />
                      <span class="text-muted truncate flex-1 font-mono text-xs">{{ item.relativePath.slice(item.relativePath.indexOf('/') + 1) }}</span>
                      <span class="text-muted shrink-0 text-xs">{{ formatSize(item.size) }}</span>
                      <UploadItemStatus :item="item" :phase="phase" @remove="removeItem(item.id)" />
                    </div>
                  </div>
                </div>

                <!-- 散文件条目（与文件夹聚合条目同款卡片样式） -->
                <div
                  v-else
                  class="border-default bg-default flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
                >
                  <NuxtIcon :name="fileIcon(group.items[0]!.name)" class="text-primary size-4 shrink-0" />
                  <span class="truncate flex-1 font-mono">{{ group.items[0]!.name }}</span>
                  <span class="text-muted shrink-0 text-xs">{{ formatSize(group.items[0]!.size) }}</span>
                  <UploadItemStatus :item="group.items[0]!" :phase="phase" @remove="removeItem(group.items[0]!.id)" />
                </div>
              </template>
            </div>
          </div>

          <!-- 汇总 -->
          <div class="text-muted text-sm">
            共 {{ itemGroups.length }} 项（{{ items.length }} 个文件）
            <template v-if="phase === 'staging'">
              ，暂存进度 {{ stagingPercent }}%
            </template>
          </div>
        </div>

        <!-- uploading / done 阶段：任务进度（扁平 fileProgress） -->
        <div v-else-if="currentTaskId" class="flex flex-col gap-2">
          <div class="text-muted text-sm font-medium">上传进度：</div>

          <!-- 排队提示（仅执行阶段显示；排队取消后 phase=done 不再展示） -->
          <div
            v-if="phase === 'uploading' && taskStatus === 'queued'"
            class="bg-info/10 text-info flex items-center gap-2 rounded-md p-3"
          >
            <NuxtIcon name="i-lucide-clock" class="size-4 shrink-0" />
            <span class="text-sm">
              排队中（第 {{ queuePosition ?? '-' }} 位），其他任务完成后自动开始
            </span>
          </div>

          <div class="bg-elevated max-h-80 overflow-y-auto rounded-md p-2">
            <div
              v-for="item in progressItems"
              :key="item.key"
              class="flex items-center gap-2 rounded px-2 py-1.5 text-sm"
              :style="{ paddingLeft: `${indentLevel(item.key) * 16 + 8}px` }"
            >
              <NuxtIcon name="i-lucide-file" class="text-muted size-4 shrink-0" />
              <span class="truncate font-mono">{{ item.name }}</span>
              <div class="flex-1" />

              <span v-if="item.status === 'pending'" class="text-muted text-xs">等待中</span>
              <span
                v-else-if="item.status === 'running'"
                class="text-primary flex items-center gap-1 text-xs"
              >
                <NuxtIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
                上传中
              </span>
              <span
                v-else-if="item.status === 'success'"
                class="text-success flex items-center gap-1 text-xs"
              >
                <NuxtIcon name="i-lucide-check" class="size-3.5" />
                {{ item.duration ? `${(item.duration / 1000).toFixed(1)}s` : '完成' }}
              </span>
              <div
                v-else-if="item.status === 'failed'"
                class="text-error flex items-center gap-1 text-xs"
              >
                <NuxtIcon name="i-lucide-x" class="size-3.5" />
                <span class="truncate" :title="item.error">{{ item.error }}</span>
              </div>
              <span v-else-if="item.status === 'skipped'" class="text-muted flex items-center gap-1 text-xs">
                <NuxtIcon name="i-lucide-slash" class="size-3.5" />
                已跳过
              </span>
            </div>
          </div>

          <!-- 汇总 -->
          <div v-if="summary && !isRunning" class="text-muted text-sm">
            总计：{{ summary.total }} 个文件，成功 {{ summary.success }} 个，失败
            {{ summary.failed }} 个<template v-if="summary.skipped > 0">，跳过 {{ summary.skipped }} 个</template>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-else class="text-muted flex flex-col items-center gap-2 py-8">
          <NuxtIcon name="i-lucide-upload-cloud" class="size-10" />
          <span class="text-sm">请选择文件或文件夹</span>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <template v-if="phase === 'select'">
          <NuxtButton color="neutral" variant="ghost" label="取消" @click="onClose" />
          <NuxtButton
            color="primary"
            icon="i-lucide-upload"
            label="开始上传"
            :disabled="items.length === 0"
            @click="startUpload"
          />
        </template>
        <template v-else-if="phase === 'staging'">
          <NuxtButton
            color="neutral"
            variant="ghost"
            label="取消（已暂存不回滚）"
            @click="cancelStaging"
          />
        </template>
        <template v-else-if="phase === 'uploading' && isRunning">
          <NuxtButton
            v-if="taskStatus === 'queued'"
            color="neutral"
            variant="ghost"
            label="取消排队"
            @click="cancelUpload"
          />
          <NuxtButton
            v-else
            color="neutral"
            variant="ghost"
            label="取消（已上传不回滚）"
            @click="cancelUpload"
          />
          <NuxtButton
            color="neutral"
            variant="ghost"
            label="后台继续"
            @click="backgroundContinue"
          />
        </template>
        <template v-else>
          <NuxtButton
            v-if="failedCount > 0 || items.some(i => i.status === 'failed')"
            color="warning"
            variant="outline"
            icon="i-lucide-rotate-cw"
            label="重试失败项"
            @click="retryFailed"
          />
          <NuxtButton color="primary" label="关闭" @click="onClose" />
        </template>
      </div>
    </template>
  </NuxtModal>
</template>
