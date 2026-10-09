<script setup lang="ts">
import { formatSize, formatDate } from '~/utils/browse'
import type { StagedFileListItem } from '#shared/schemas/task'

const open = ref(false)
const files = ref<StagedFileListItem[]>([])
const loading = ref(false)
const deleting = ref(false)
const toast = useToast()

async function refresh() {
  loading.value = true
  try {
    const res = await $fetch<{ files: StagedFileListItem[] }>('/api/staging')
    files.value = res.files
  } catch {
    toast.add({ title: '加载暂存文件失败', color: 'error' })
  } finally {
    loading.value = false
  }
}

watch(open, (val) => {
  if (val) void refresh()
})

async function removeOne(fileId: string) {
  deleting.value = true
  try {
    await $fetch('/api/staging', {
      method: 'DELETE',
      body: { fileIds: [fileId] },
    })
    files.value = files.value.filter((f) => f.fileId !== fileId)
    toast.add({ title: '已删除暂存文件', color: 'success' })
  } catch {
    toast.add({ title: '删除失败', color: 'error' })
  } finally {
    deleting.value = false
  }
}

async function clearAll() {
  if (!files.value.length) return
  deleting.value = true
  try {
    await $fetch('/api/staging', { method: 'DELETE', body: {} })
    files.value = []
    toast.add({ title: '已清空暂存', color: 'success' })
  } catch {
    toast.add({ title: '清空失败', color: 'error' })
  } finally {
    deleting.value = false
  }
}

const totalSize = computed(() => files.value.reduce((s, f) => s + (f.size || 0), 0))
</script>

<template>
  <NuxtTooltip text="暂存文件管理">
    <NuxtButton
      color="neutral"
      variant="ghost"
      icon="i-lucide-hard-drive-download"
      @click="() => { open = true }"
    />
  </NuxtTooltip>

  <NuxtModal v-model:open="open" title="暂存文件" description="未提交的上传/分发暂存，可手动清理">
    <template #body>
      <div class="flex min-h-0 flex-col gap-3">
        <div class="text-muted flex items-center justify-between text-sm">
          <span>
            共 {{ files.length }} 个 · {{ formatSize(totalSize) }}
            <span class="ms-1 text-xs">（TTL 自动清理兜底）</span>
          </span>
          <div class="flex items-center gap-2">
            <NuxtButton
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-refresh-cw"
              :loading="loading"
              @click="refresh"
            />
            <NuxtButton
              size="xs"
              color="error"
              variant="soft"
              icon="i-lucide-trash-2"
              label="全部清空"
              :disabled="!files.length || deleting"
              :loading="deleting"
              @click="clearAll"
            />
          </div>
        </div>

        <div v-if="loading && !files.length" class="text-muted py-8 text-center text-sm">
          加载中...
        </div>
        <div v-else-if="!files.length" class="text-muted flex flex-col items-center gap-2 py-8">
          <NuxtIcon name="i-lucide-inbox" class="size-8" />
          <span>没有暂存文件</span>
        </div>
        <div v-else class="border-default max-h-[360px] overflow-y-auto rounded-md border">
          <div
            v-for="f in files"
            :key="f.fileId"
            class="border-default flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
          >
            <NuxtIcon name="i-lucide-file" class="text-muted size-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate font-mono text-sm">{{ f.originalName }}</span>
                <span class="text-muted shrink-0 text-xs">{{ formatSize(f.size) }}</span>
              </div>
              <div class="text-muted truncate text-xs">
                <span v-if="f.objectKey" class="font-mono">{{ f.objectKey }}</span>
                <span v-else>无路径信息</span>
                <span class="ms-2">{{ formatDate(f.stagedAt) }}</span>
              </div>
            </div>
            <NuxtTooltip text="删除">
              <NuxtButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :loading="deleting"
                @click="removeOne(f.fileId)"
              />
            </NuxtTooltip>
          </div>
        </div>
      </div>
    </template>
  </NuxtModal>
</template>
