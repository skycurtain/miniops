<script setup lang="ts">
import type { BrowseTab } from '~/pages/browse/types'

defineProps<{
  tabs: BrowseTab[]
  activeTabId: string
}>()

const emit = defineEmits<{
  switch: [instanceId: string]
  close: [instanceId: string]
}>()

/** 鼠标滚轮横向滚动标签栏（触摸板水平滚动时尊重原生行为） */
function onTabWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement
  if (e.deltaX !== 0) return
  el.scrollLeft += e.deltaY
}
</script>

<template>
  <div
    v-if="tabs.length"
    class="border-default flex min-w-0 shrink-0 items-center gap-0 overflow-x-auto border-b"
    @wheel.prevent="onTabWheel"
  >
    <button
      v-for="tab in tabs"
      :key="tab.instanceId"
      :title="tab.instanceName"
      class="group border-default flex shrink-0 items-center gap-2 border-r px-3 py-2 text-left text-sm transition-colors"
      :class="{
        'bg-primary/10 text-primary font-medium': activeTabId === tab.instanceId,
        'text-muted hover:bg-elevated': activeTabId !== tab.instanceId,
      }"
      style="width: 200px"
      @click="emit('switch', tab.instanceId)"
    >
      <NuxtIcon
        name="i-lucide-server"
        class="size-4 shrink-0"
        :class="activeTabId === tab.instanceId ? 'text-primary' : 'text-muted'"
      />
      <span class="truncate" style="width: 120px">{{ tab.instanceName }}</span>
      <span
        class="hover:bg-elevated flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md"
        @click.stop="emit('close', tab.instanceId)"
      >
        <NuxtIcon name="i-lucide-x" class="size-3.5" />
      </span>
    </button>
  </div>
</template>
