<script setup lang="ts">
import type { ObjectInfo } from '#shared/schemas/browse'
import { formatSize, formatDate, fileIcon, type PreviewType } from '~/utils/browse'

const props = defineProps<{
  open: boolean
  objectKey: string
  previewType: PreviewType
  object: ObjectInfo | null
  instanceId: string
  bucket: string
  instanceName: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const previewObject = computed(() => props.object)

const textContent = ref('')
const textLoading = ref(false)
const textError = ref('')

function buildPreviewUrl(key: string): string {
  const params = new URLSearchParams({
    instanceId: props.instanceId,
    bucket: props.bucket,
    key,
    inline: '1',
  })
  return `/api/browse/objects/download?${params.toString()}`
}

async function fetchTextContent(key: string) {
  const obj = previewObject.value
  if (obj && obj.size > 2 * 1024 * 1024) {
    textError.value = `文件过大（${formatSize(obj.size)} > 2MB），请下载后查看`
    return
  }
  textLoading.value = true
  textError.value = ''
  textContent.value = ''
  try {
    const res = await fetch(buildPreviewUrl(key))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (text.length > 0) {
      const replacementCount = (text.match(/\uFFFD/g) || []).length
      if (replacementCount / text.length > 0.1) {
        textError.value = '该文件可能不是文本文件，请下载后查看'
        return
      }
    }
    textContent.value = text
  } catch (e: unknown) {
    textError.value = e instanceof Error ? e.message : '加载失败'
  } finally {
    textLoading.value = false
  }
}

function downloadObject(key: string) {
  const params = new URLSearchParams({
    instanceId: props.instanceId,
    bucket: props.bucket,
    key,
  })
  const a = document.createElement('a')
  a.href = `/api/browse/objects/download?${params.toString()}`
  a.download = key.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

watch([() => props.open, () => props.objectKey], () => {
  if (!props.open) return
  textContent.value = ''
  textError.value = ''
  if (props.previewType === 'text') {
    fetchTextContent(props.objectKey)
  }
})
</script>

<template>
  <NuxtSlideover
    :open="open"
    title="对象预览"
    side="right"
    :ui="{ content: 'w-full max-w-2xl sm:max-w-3xl' }"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <div class="flex h-full flex-col gap-3">
        <div class="border-default flex items-start justify-between gap-4 border-b pb-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <NuxtIcon
                v-if="objectKey"
                :name="fileIcon(objectKey)"
                class="text-muted size-4 shrink-0"
              />
              <span class="text-highlighted truncate font-mono font-medium">
                {{ objectKey.split('/').pop() }}
              </span>
            </div>
            <div v-if="previewObject" class="text-muted mt-1 text-xs">
              {{ formatSize(previewObject.size) }} ·
              {{ formatDate(previewObject.lastModified) }}
            </div>
            <div class="text-muted mt-0.5 text-xs">{{ instanceName }} / {{ bucket }}</div>
          </div>
          <NuxtButton
            size="sm"
            color="primary"
            variant="outline"
            icon="i-lucide-download"
            label="下载"
            @click="downloadObject(objectKey)"
          />
        </div>

        <div class="min-h-0 flex-1 overflow-auto">
          <div
            v-if="previewType === 'image'"
            class="bg-elevated/50 flex min-h-75 items-center justify-center rounded-md"
          >
            <img
              :src="buildPreviewUrl(objectKey)"
              :alt="objectKey"
              class="max-h-[70vh] max-w-full object-contain"
            />
          </div>

          <div
            v-else-if="previewType === 'video'"
            class="bg-elevated/50 flex min-h-75 items-center justify-center rounded-md"
          >
            <video
              :src="buildPreviewUrl(objectKey)"
              controls
              preload="metadata"
              class="max-h-[70vh] max-w-full"
            >
              您的浏览器不支持视频播放
            </video>
          </div>

          <div
            v-else-if="previewType === 'audio'"
            class="flex flex-col items-center justify-center gap-4 py-12"
          >
            <NuxtIcon name="i-lucide-music" class="text-primary size-16" />
            <span class="text-muted text-sm">{{ objectKey.split('/').pop() }}</span>
            <audio :src="buildPreviewUrl(objectKey)" controls>您的浏览器不支持音频播放</audio>
          </div>

          <div v-else-if="previewType === 'text'">
            <div v-if="textLoading" class="text-muted flex items-center justify-center py-12">
              <NuxtIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
              <span class="ml-2">加载中…</span>
            </div>
            <div v-else-if="textError" class="flex flex-col items-center gap-2 py-12">
              <NuxtIcon name="i-lucide-file-warning" class="text-warning size-8" />
              <span class="text-warning px-4 text-center">{{ textError }}</span>
            </div>
            <pre
              v-else
              class="bg-elevated max-h-[70vh] overflow-auto rounded-md p-4 font-mono text-xs break-all whitespace-pre-wrap"
            ><code>{{ textContent }}</code></pre>
          </div>
        </div>
      </div>
    </template>
  </NuxtSlideover>
</template>
