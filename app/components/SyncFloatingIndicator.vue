<script setup lang="ts">
const props = defineProps<{
  isRunning: boolean
  isScanning: boolean
  scannedCount: number
  taskSummary: { total: number; success: number; failed: number } | null
  completedCount: number
  totalCount: number
}>()

const emit = defineEmits<{
  reopen: []
}>()

const percent = computed(() => {
  if (props.taskSummary) return 100
  if (props.totalCount === 0) return 0
  return Math.round(props.completedCount / props.totalCount * 100)
})
</script>

<template>
  <div class="fixed bottom-4 right-4 z-50 cursor-pointer" @click="emit('reopen')">
    <div class="rounded-lg border border-default bg-default shadow-lg p-3 min-w-48 transition-all hover:shadow-xl">
      <!-- 扫描中 -->
      <div v-if="isScanning" class="flex items-center gap-2">
        <NuxtIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary shrink-0" />
        <span class="text-sm text-muted">扫描中... {{ scannedCount }} 个</span>
      </div>

      <!-- 同步中 -->
      <div v-else-if="isRunning" class="flex flex-col gap-1.5">
        <div class="flex items-center gap-2">
          <NuxtIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary shrink-0" />
          <span class="text-sm font-medium">同步中 {{ completedCount }}/{{ totalCount }}</span>
        </div>
        <NuxtProgress :model-value="percent" size="sm" />
      </div>

      <!-- 全部成功 -->
      <div v-else-if="taskSummary && taskSummary.failed === 0" class="flex items-center gap-2">
        <NuxtIcon name="i-lucide-check-circle" class="size-4 text-success shrink-0" />
        <span class="text-sm font-medium text-success">同步完成 {{ taskSummary.total }}/{{ taskSummary.total }}</span>
      </div>

      <!-- 有失败 -->
      <div v-else-if="taskSummary" class="flex items-center gap-2">
        <NuxtIcon name="i-lucide-triangle-alert" class="size-4 text-warning shrink-0" />
        <span class="text-sm font-medium text-warning">完成 {{ taskSummary.success }}/{{ taskSummary.total }}，{{ taskSummary.failed }} 失败</span>
      </div>
    </div>
  </div>
</template>
