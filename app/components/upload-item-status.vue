<script setup lang="ts">
/**
 * 上传弹窗待上传列表的单文件状态单元。
 *
 * 状态（等待中/进度条/完成/失败）+ select 阶段的行内移除按钮。
 * 供文件夹聚合展开明细与散文件条目复用。
 */
const props = defineProps<{
  item: {
    status: 'pending' | 'uploading' | 'success' | 'failed'
    progress: number
    error?: string
  }
  phase: string
}>()

const emit = defineEmits<{
  remove: []
}>()
</script>

<template>
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
    class="group/item size-5 opacity-0 group-hover/item:opacity-100"
    @click="emit('remove')"
  />
</template>
