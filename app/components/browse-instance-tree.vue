<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'
import type { InstanceGroup, MinioInstance } from '#shared/schemas/groups'

const props = defineProps<{
  groups: InstanceGroup[]
  activeTabId: string
  openedInstanceIds: Set<string>
}>()

const emit = defineEmits<{
  open: [instance: MinioInstance]
}>()

interface InstanceTreeItem extends TreeItem {
  instanceId?: string
  endpoint?: string
  children?: InstanceTreeItem[]
}

const treeItems = computed<InstanceTreeItem[]>(() =>
  props.groups.map((g) => ({
    label: g.name,
    icon: 'i-lucide-folder',
    defaultExpanded: true,
    children: g.instances
      .filter((i) => i.enabled)
      .map((i) => ({
        label: i.name,
        icon: 'i-lucide-server',
        instanceId: i.id,
        endpoint: i.endpoint,
        onSelect: () => emit('open', i),
      })),
  })),
)

function findInstance(id: string): MinioInstance | undefined {
  for (const g of props.groups) {
    const inst = g.instances.find((i) => i.id === id)
    if (inst) return inst
  }
  return undefined
}

const treeSelected = computed({
  get: () => {
    if (!props.activeTabId) return undefined
    for (const g of treeItems.value) {
      const found = g.children?.find((c) => c.instanceId === props.activeTabId)
      if (found) return found
    }
    return undefined
  },
  set: (val) => {
    if (val && (val as InstanceTreeItem).instanceId) {
      const instance = findInstance((val as InstanceTreeItem).instanceId!)
      if (instance) emit('open', instance)
    }
  },
})
</script>

<template>
  <div
    class="border-default bg-default flex w-64 shrink-0 flex-col overflow-hidden rounded-lg border"
  >
    <div class="flex shrink-0 items-center px-3 py-2">
      <span class="text-highlighted text-sm font-semibold">实例树</span>
    </div>
    <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2">
      <NuxtTree
        v-model="treeSelected"
        :items="treeItems"
        :get-key="(item: InstanceTreeItem) => item.instanceId ?? (item.label as string)"
        color="primary"
        size="sm"
      >
        <template #item-label="{ item }">
          <span
            class="truncate text-sm font-medium"
            :class="(item as InstanceTreeItem).instanceId ? 'text-highlighted' : 'text-highlighted'"
            :title="(item as InstanceTreeItem).endpoint"
          >
            {{ item.label }}
          </span>
        </template>
        <template #item-trailing="{ item }">
          <span
            v-if="
              (item as InstanceTreeItem).instanceId &&
              activeTabId === (item as InstanceTreeItem).instanceId
            "
            class="bg-primary size-2 shrink-0 rounded-full"
          />
          <span
            v-else-if="
              (item as InstanceTreeItem).instanceId &&
              openedInstanceIds.has((item as InstanceTreeItem).instanceId!)
            "
            class="border-primary size-2 shrink-0 rounded-full border-2"
          />
        </template>
      </NuxtTree>
    </div>
  </div>
</template>
