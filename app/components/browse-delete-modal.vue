<script setup lang="ts">
import { h, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'

type DeletePhase = 'idle' | 'scanning' | 'confirm' | 'deleting' | 'done'

interface DeleteItem {
  key: string
  name: string
  status: 'pending' | 'deleted' | 'failed'
  error?: string
}

const props = defineProps<{
  open: boolean
  instanceId: string
  bucket: string
  prefix: string
  target: { type: 'object' | 'folder'; key: string } | null
  selectedKeys: string[]
  selectedPrefixes: string[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  complete: []
}>()

const toast = useToast()

const deletePhase = ref<DeletePhase>('idle')
const deleteItems = ref<DeleteItem[]>([])
const deleteSummary = ref({ total: 0, success: 0, failed: 0 })

const deleteColumns: TableColumn<DeleteItem>[] = [
  {
    accessorKey: 'name',
    header: '文件名',
    cell: ({ row }: { row: { original: DeleteItem } }) =>
      h('span', { class: 'truncate font-mono text-sm' }, row.original.name),
  },
  {
    id: 'status',
    header: '状态',
    cell: ({ row }: { row: { original: DeleteItem } }) => {
      const item = row.original
      if (item.status === 'deleted') {
        return h('span', { class: 'text-success flex items-center gap-1 justify-end text-xs' }, [
          h(resolveComponent('NuxtIcon'), { name: 'i-lucide-check', class: 'size-3' }),
          '已删除',
        ])
      }
      if (item.status === 'failed') {
        return h(
          'span',
          { class: 'text-error flex items-center gap-1 justify-end text-xs', title: item.error },
          [
            h(resolveComponent('NuxtIcon'), { name: 'i-lucide-x', class: 'size-3' }),
            item.error || '失败',
          ],
        )
      }
      if (deletePhase.value === 'deleting') {
        return h('span', { class: 'text-primary flex items-center gap-1 justify-end text-xs' }, [
          h(resolveComponent('NuxtIcon'), {
            name: 'i-lucide-loader-circle',
            class: 'size-3 animate-spin',
          }),
          '删除中',
        ])
      }
      return h('span', { class: 'text-muted text-xs' }, '-')
    },
  },
]

const deleteIsRunning = computed(
  () => deletePhase.value === 'scanning' || deletePhase.value === 'deleting',
)

function getEffectiveSelection() {
  if (props.target) {
    return props.target.type === 'object'
      ? { keys: [props.target.key], prefixes: [] as string[] }
      : { keys: [] as string[], prefixes: [props.target.key] }
  }
  return { keys: props.selectedKeys, prefixes: props.selectedPrefixes }
}

async function start() {
  deletePhase.value = 'scanning'
  deleteItems.value = []
  deleteSummary.value = { total: 0, success: 0, failed: 0 }

  const { keys, prefixes } = getEffectiveSelection()
  try {
    const res = await $fetch<{ items: { key: string; name: string }[]; total: number }>(
      '/api/browse/objects/delete/preview',
      {
        method: 'POST',
        body: {
          instanceId: props.instanceId,
          bucket: props.bucket,
          keys: [...keys],
          prefixes: [...prefixes],
        },
      },
    )
    deleteItems.value = res.items.map((item) => ({
      key: item.key,
      name: item.name,
      status: 'pending' as const,
    }))
    deleteSummary.value = { total: res.total, success: 0, failed: 0 }
    deletePhase.value = 'confirm'
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    toast.add({
      title: '统计失败',
      description: err?.data?.message || err?.message || '未知错误',
      color: 'error',
    })
    emit('update:open', false)
    deletePhase.value = 'idle'
  }
}

async function onConfirmDelete() {
  deletePhase.value = 'deleting'

  const allKeys = deleteItems.value.map((i) => i.key)
  const batchSize = 1000

  try {
    for (let i = 0; i < allKeys.length; i += batchSize) {
      const batch = allKeys.slice(i, i + batchSize)
      const res = await $fetch<{ deleted: string[]; errors: { key: string; error: string }[] }>(
        '/api/browse/objects/delete',
        {
          method: 'POST',
          body: {
            instanceId: props.instanceId,
            bucket: props.bucket,
            keys: batch,
            prefixes: [],
          },
        },
      )
      // 更新每个文件的删除状态
      const deletedSet = new Set(res.deleted)
      const errorMap = new Map(res.errors.map((e) => [e.key, e.error]))
      for (const key of batch) {
        const item = deleteItems.value.find((it) => it.key === key)
        if (!item) continue
        if (errorMap.has(key)) {
          item.status = 'failed'
          item.error = errorMap.get(key)
          deleteSummary.value.failed++
        } else if (deletedSet.has(key)) {
          item.status = 'deleted'
          deleteSummary.value.success++
        } else {
          // 兜底：不在 deleted 也不在 errors，视为成功
          item.status = 'deleted'
          deleteSummary.value.success++
        }
      }
    }

    deletePhase.value = 'done'
    emit('complete')
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    toast.add({
      title: '删除失败',
      description: err?.data?.message || err?.message || '未知错误',
      color: 'error',
    })
    deletePhase.value = 'confirm'
  }
}

function onDeleteClose() {
  emit('update:open', false)
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      start()
    } else {
      deletePhase.value = 'idle'
      deleteItems.value = []
      deleteSummary.value = { total: 0, success: 0, failed: 0 }
    }
  },
)
</script>

<template>
  <NuxtModal
    :open="open"
    title="确认删除"
    :dismissible="false"
    :close="!deleteIsRunning"
    :ui="{ content: 'w-[calc(100vw-2rem)] max-w-2xl' }"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <!-- 统计中 -->
      <div v-if="deletePhase === 'scanning'" class="flex items-center justify-center gap-2 py-8">
        <NuxtIcon name="i-lucide-loader-circle" class="text-primary size-5 animate-spin" />
        <span class="text-muted text-sm">正在统计...</span>
      </div>

      <!-- 确认删除 -->
      <div v-else-if="deletePhase === 'confirm'" class="flex flex-col gap-3">
        <div class="text-warning flex items-center gap-2">
          <NuxtIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" />
          <span class="text-sm">将要删除 {{ deleteSummary.total }} 个对象，操作不可撤销</span>
        </div>
        <NuxtTable
          :data="deleteItems"
          :columns="deleteColumns"
          :virtualize="{ estimateSize: 36 }"
          :ui="{ td: 'px-4 py-1.5 text-sm text-muted whitespace-nowrap' }"
          sticky
          class="h-[300px]"
        />
      </div>

      <!-- 删除中 -->
      <div v-else-if="deletePhase === 'deleting'" class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <div class="bg-default h-2 flex-1 overflow-hidden rounded-full">
            <div
              class="bg-primary h-full transition-all"
              :style="{
                width: `${deleteSummary.total > 0 ? ((deleteSummary.success + deleteSummary.failed) / deleteSummary.total) * 100 : 0}%`,
              }"
            />
          </div>
          <span class="text-muted text-xs"
            >{{ deleteSummary.success + deleteSummary.failed }}/{{ deleteSummary.total }}</span
          >
        </div>
        <NuxtTable
          :data="deleteItems"
          :columns="deleteColumns"
          :virtualize="{ estimateSize: 36 }"
          :ui="{ td: 'px-4 py-1.5 text-sm text-muted whitespace-nowrap' }"
          sticky
          class="h-[300px]"
        />
      </div>

      <!-- 完成 -->
      <div v-else-if="deletePhase === 'done'" class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <NuxtIcon name="i-lucide-check-circle" class="text-success size-5 shrink-0" />
          <span class="text-sm">
            <span class="text-muted">共 {{ deleteSummary.total }} 个对象，</span>
            <span class="text-success">{{ deleteSummary.success }} 成功</span>
            <span v-if="deleteSummary.failed > 0" class="text-error">
              ，{{ deleteSummary.failed }} 失败
            </span>
          </span>
        </div>
        <NuxtTable
          :data="deleteItems"
          :columns="deleteColumns"
          :virtualize="{ estimateSize: 36 }"
          :ui="{ td: 'px-4 py-1.5 text-sm text-muted whitespace-nowrap' }"
          sticky
          class="h-[300px]"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <template v-if="deletePhase === 'confirm'">
          <NuxtButton color="neutral" variant="ghost" label="取消" @click="onDeleteClose" />
          <NuxtButton
            color="error"
            icon="i-lucide-trash-2"
            label="确认删除"
            @click="onConfirmDelete"
          />
        </template>
        <template v-else-if="deletePhase === 'deleting'">
          <NuxtButton color="neutral" variant="ghost" label="取消" disabled />
          <NuxtButton color="error" label="删除中..." loading disabled />
        </template>
        <template v-else-if="deletePhase === 'done'">
          <NuxtButton color="primary" label="关闭" @click="onDeleteClose" />
        </template>
      </div>
    </template>
  </NuxtModal>
</template>
