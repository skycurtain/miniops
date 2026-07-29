<script setup lang="ts">
/**
 * 上传弹窗
 *
 * 选择文件/文件夹 -> 待上传列表 -> 逐个上传 + 进度 -> 完成
 * 使用 XMLHttpRequest 实现真实上传进度，后端流式转发 PutObject。
 */

import { formatSize } from '~/utils/browse'

interface UploadItem {
  id: string
  file: File
  name: string
  relativePath: string
  size: number
  status: 'pending' | 'uploading' | 'success' | 'failed'
  progress: number
  error?: string
}

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

const items = ref<UploadItem[]>([])
const phase = ref<'select' | 'uploading' | 'done'>('select')
const fileInput = ref<HTMLInputElement>()
const folderInput = ref<HTMLInputElement>()

const summary = computed(() => {
  const total = items.value.length
  const success = items.value.filter((i) => i.status === 'success').length
  const failed = items.value.filter((i) => i.status === 'failed').length
  return { total, success, failed }
})

const targetPath = computed(() => {
  const parts = [props.instanceName, props.bucket]
  if (props.prefix) parts.push(props.prefix)
  return parts.join(' / ')
})

watch(
  () => props.open,
  (open) => {
    if (open) {
      items.value = []
      phase.value = 'select'
    }
  },
)

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

// ==================== 上传执行 ====================

let cancelled = false
let currentXhr: XMLHttpRequest | null = null

async function startUpload() {
  cancelled = false
  phase.value = 'uploading'

  const pending = items.value.filter((i) => i.status === 'pending' || i.status === 'failed')
  for (const item of pending) {
    if (cancelled) return
    item.status = 'uploading'
    item.progress = 0
    item.error = undefined

    try {
      await uploadSingleFile(item)
      item.status = 'success'
      item.progress = 100
    } catch (e: unknown) {
      if (cancelled) return
      item.status = 'failed'
      item.error = e instanceof Error ? e.message : '上传失败'
    }
  }

  if (cancelled) return
  phase.value = 'done'

  const s = summary.value
  if (s.failed > 0) {
    toast.add({
      title: `上传完成：成功 ${s.success} 个，失败 ${s.failed} 个`,
      color: 'warning',
    })
  } else {
    toast.add({ title: `上传完成：${s.success} 个文件`, color: 'success' })
  }
}

/** 用 XMLHttpRequest 上传单个文件，支持进度回调 */
function uploadSingleFile(item: UploadItem): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const formData = new FormData()
    formData.append('instanceId', props.instanceId)
    formData.append('bucket', props.bucket)
    formData.append('prefix', props.prefix)
    // 文件夹上传时传完整相对路径，保留目录结构
    formData.append('relativePath', item.relativePath)
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
        resolve()
      } else {
        let msg = `HTTP ${xhr.status}`
        try {
          const err = JSON.parse(xhr.responseText)
          msg = err.statusMessage || err.message || msg
        } catch {
          // 非 JSON 错误响应
        }
        reject(new Error(msg))
      }
    })

    xhr.addEventListener('error', () => reject(new Error('网络错误')))
    xhr.addEventListener('abort', () => reject(new Error('已取消')))

    xhr.open('POST', '/api/browse/objects/upload')
    xhr.send(formData)
  }).finally(() => {
    currentXhr = null
  })
}

function retryFailed() {
  for (const item of items.value) {
    if (item.status === 'failed') {
      item.status = 'pending'
      item.progress = 0
      item.error = undefined
    }
  }
  phase.value = 'select'
}

function cancelUpload() {
  cancelled = true
  // 中止当前正在上传的请求
  currentXhr?.abort()
  currentXhr = null
  phase.value = 'select'
  for (const item of items.value) {
    if (item.status === 'uploading' || item.status === 'pending') {
      item.status = 'pending'
      item.progress = 0
    }
  }
}

function onClose() {
  if (phase.value === 'done' && summary.value.success > 0) {
    emit('complete')
  }
  emit('update:open', false)
}

/** 获取目录层级缩进 */
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
    :close="phase !== 'uploading'"
    :ui="{ content: 'w-[calc(100vw-2rem)] max-w-2xl' }"
    @update:open="(v: boolean) => { if (!v && phase === 'uploading') return; emit('update:open', v) }"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <!-- 选择文件按钮 -->
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

        <!-- 待上传列表 -->
        <div v-if="items.length" class="flex flex-col gap-2">
          <div class="text-muted text-sm font-medium">待上传列表：</div>
          <div class="bg-elevated max-h-80 overflow-y-auto rounded-md p-2">
            <div
              v-for="item in items"
              :key="item.id"
              class="group flex items-center gap-2 rounded px-2 py-1.5 text-sm"
              :style="{ paddingLeft: `${indentLevel(item.relativePath) * 16 + 8}px` }"
            >
              <NuxtIcon name="i-lucide-file" class="text-muted size-4 shrink-0" />
              <span class="truncate font-mono">{{ item.name }}</span>
              <span class="text-muted shrink-0 text-xs">{{ formatSize(item.size) }}</span>
              <div class="flex-1" />

              <!-- 状态 -->
              <span v-if="item.status === 'pending'" class="text-muted text-xs">等待中</span>
              <div v-else-if="item.status === 'uploading'" class="flex items-center gap-2">
                <div class="bg-default h-1.5 w-24 overflow-hidden rounded-full">
                  <div
                    class="bg-primary h-full transition-all"
                    :style="{ width: `${item.progress}%` }"
                  />
                </div>
                <span class="text-primary text-xs">{{ Math.floor(item.progress) }}%</span>
              </div>
              <span
                v-else-if="item.status === 'success'"
                class="text-success flex items-center gap-1 text-xs"
              >
                <NuxtIcon name="i-lucide-check" class="size-3.5" />
                完成
              </span>
              <div
                v-else-if="item.status === 'failed'"
                class="text-error flex items-center gap-1 text-xs"
              >
                <NuxtIcon name="i-lucide-x" class="size-3.5" />
                <span class="truncate" :title="item.error">{{ item.error }}</span>
              </div>

              <!-- 移除按钮（仅 select 阶段） -->
              <NuxtButton
                v-if="phase === 'select'"
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-x"
                class="size-5 opacity-0 group-hover:opacity-100"
                @click="removeItem(item.id)"
              />
            </div>
          </div>

          <!-- 汇总 -->
          <div class="text-muted text-sm">
            总计：{{ summary.total }} 个文件
            <template v-if="phase === 'done'">
              ，已上传 {{ summary.success }} 个，失败 {{ summary.failed }} 个
            </template>
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
        <template v-else-if="phase === 'uploading'">
          <NuxtButton
            color="neutral"
            variant="ghost"
            label="取消（已上传不回滚）"
            @click="cancelUpload"
          />
        </template>
        <template v-else>
          <NuxtButton
            v-if="summary.failed > 0"
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
