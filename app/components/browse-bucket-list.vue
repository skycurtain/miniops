<script setup lang="ts">
import type { BucketInfo } from '#shared/schemas/browse'
import { formatDate } from '~/utils/browse'

defineProps<{
  instanceName: string
  buckets: BucketInfo[]
  loading: boolean
  error: string
}>()

const emit = defineEmits<{
  select: [bucketName: string]
  retry: []
}>()
</script>

<template>
  <!-- Bucket 加载失败 -->
  <div v-if="error" class="flex h-full items-center justify-center">
    <div class="flex flex-col items-center gap-3 text-center">
      <NuxtIcon name="i-lucide-cloud-off" class="text-error size-10" />
      <p class="text-error">{{ error }}</p>
      <NuxtButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-refresh-cw"
        label="重试"
        @click="emit('retry')"
      />
    </div>
  </div>

  <!-- Bucket 列表 -->
  <div v-else class="flex h-full flex-col">
    <div class="border-default flex shrink-0 items-center gap-2 border-b px-4 py-3">
      <NuxtIcon name="i-lucide-server" class="text-primary size-5" />
      <span class="text-highlighted font-semibold">{{ instanceName }}</span>
      <NuxtBadge color="neutral" variant="subtle" size="sm">
        {{ buckets.length }} 个 bucket
      </NuxtBadge>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <div v-if="loading" class="flex items-center justify-center py-12">
        <NuxtIcon name="i-lucide-loader-circle" class="text-muted size-6 animate-spin" />
      </div>
      <div v-else-if="!buckets.length" class="flex flex-col items-center gap-3 py-16">
        <NuxtIcon name="i-lucide-database-zap" class="text-muted size-10" />
        <p class="text-muted">该实例下没有可用的 bucket</p>
      </div>
      <div v-else class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <button
          v-for="b in buckets"
          :key="b.name"
          class="border-default hover:border-primary hover:bg-primary/5 group flex cursor-pointer items-center gap-3 rounded-lg border p-4 text-left transition-colors"
          @click="emit('select', b.name)"
        >
          <NuxtIcon name="i-lucide-database" class="text-primary size-8 shrink-0" />
          <div class="min-w-0 flex-1">
            <p class="text-highlighted truncate font-mono font-medium">{{ b.name }}</p>
            <p class="text-muted text-xs">{{ formatDate(b.createdAt) }}</p>
          </div>
          <NuxtIcon
            name="i-lucide-chevron-right"
            class="text-muted size-4 shrink-0 opacity-0 group-hover:opacity-100"
          />
        </button>
      </div>
    </div>
  </div>
</template>
