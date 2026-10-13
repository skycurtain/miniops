<script setup lang="ts">
import { h, resolveComponent } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import type { BrowseTab, BrowseTableRow } from '~/types/browse'
import { formatSize, formatDate, fileIcon, getPreviewType, displayName } from '~/utils/browse'

const props = defineProps<{
  tab: BrowseTab
}>()

const emit = defineEmits<{
  navigate: [prefix: string]
  back: []
  refresh: []
  upload: []
  download: [target?: { type: 'object' | 'folder'; key: string }]
  delete: [target?: { type: 'object' | 'folder'; key: string }]
  copy: [target?: { type: 'object' | 'folder'; key: string }]
  move: [target?: { type: 'object' | 'folder'; key: string }]
  'copy-path': [path: string]
  preview: [key: string]
  'toggle-select-all': []
  'toggle-select-key': [key: string]
  'toggle-select-prefix': [prefix: string]
  'load-more': []
}>()

// ==================== 面包屑 ====================
function getBreadcrumbs(tab: BrowseTab) {
  const p = tab.currentPrefix
  if (!p) return [{ label: tab.selectedBucket, prefix: '' }]
  const segments = p.replace(/\/$/, '').split('/').filter(Boolean)
  const crumbs = [{ label: tab.selectedBucket, prefix: '' }]
  let acc = ''
  for (const seg of segments) {
    acc += `${seg}/`
    crumbs.push({ label: `${seg}/`, prefix: acc })
  }
  return crumbs
}

// ==================== 多选 ====================
function allSelectable(tab: BrowseTab): string[] {
  return [...tab.commonPrefixes, ...tab.objects.map((o) => o.key)]
}

function selectedCount(tab: BrowseTab): number {
  return tab.selectedKeys.size + tab.selectedPrefixes.size
}

function isAllSelected(tab: BrowseTab): boolean {
  const all = allSelectable(tab)
  return all.length > 0 && all.every((k) => tab.selectedKeys.has(k) || tab.selectedPrefixes.has(k))
}

function isPartialSelected(tab: BrowseTab): boolean {
  const all = allSelectable(tab)
  return (
    all.some((k) => tab.selectedKeys.has(k) || tab.selectedPrefixes.has(k)) && !isAllSelected(tab)
  )
}

// ==================== Table 数据和列定义 ====================
const tableData = computed<BrowseTableRow[]>(() => {
  const tab = props.tab
  const folders: BrowseTableRow[] = tab.commonPrefixes.map((cp) => ({
    type: 'folder',
    key: cp,
    name: cp.replace(tab.currentPrefix, ''),
  }))
  const objects: BrowseTableRow[] = tab.objects.map((obj) => ({
    type: 'object',
    key: obj.key,
    name: displayName(obj.key, tab.currentPrefix),
    size: obj.size,
    lastModified: obj.lastModified,
  }))
  return [...folders, ...objects]
})

const NuxtCheckboxComponent = resolveComponent('NuxtCheckbox')

const browseColumns: TableColumn<BrowseTableRow>[] = [
  {
    id: 'select',
    header: () => {
      const tab = props.tab
      return h(NuxtCheckboxComponent, {
        modelValue: isPartialSelected(tab) ? 'indeterminate' : isAllSelected(tab),
        'onUpdate:modelValue': () => emit('toggle-select-all'),
      })
    },
    cell: ({ row }) => {
      const tab = props.tab
      const isSelected =
        row.original.type === 'folder'
          ? tab.selectedPrefixes.has(row.original.key)
          : tab.selectedKeys.has(row.original.key)
      return h(NuxtCheckboxComponent, {
        modelValue: isSelected,
        'onUpdate:modelValue': () => {
          if (row.original.type === 'folder') emit('toggle-select-prefix', row.original.key)
          else emit('toggle-select-key', row.original.key)
        },
      })
    },
  },
  {
    id: 'name',
    header: '名称',
    meta: { class: { th: 'w-80', td: 'w-80' } },
  },
  {
    id: 'size',
    header: '大小',
    meta: { class: { th: 'w-24', td: 'w-24' } },
  },
  {
    id: 'lastModified',
    header: '修改时间',
    meta: { class: { th: 'w-40', td: 'w-40' } },
  },
  {
    id: 'actions',
    header: '',
    meta: { class: { th: 'w-40', td: 'w-40' } },
  },
]

// ==================== 无限滚动 ====================
function onTableScroll(e: Event) {
  const tab = props.tab
  if (!tab.hasMore || tab.loadingMore) return
  const el = e.target as HTMLElement
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
    emit('load-more')
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="border-default shrink-0 border-b px-4 py-2">
      <!-- 面包屑 -->
      <div class="flex flex-wrap items-center gap-1 text-sm">
        <button class="text-muted hover:text-primary" @click="emit('back')">
          {{ tab.instanceName }}
        </button>
        <template v-for="(crumb, idx) in getBreadcrumbs(tab)" :key="idx">
          <NuxtIcon name="i-lucide-chevron-right" class="text-muted size-3" />
          <button
            class="font-mono"
            :class="
              idx === getBreadcrumbs(tab).length - 1
                ? 'text-highlighted font-semibold'
                : 'text-muted hover:text-primary'
            "
            @click="emit('navigate', crumb.prefix)"
          >
            {{ crumb.label }}
          </button>
        </template>
      </div>

      <!-- 工具栏 -->
      <div class="mt-2 flex items-center gap-2">
        <NuxtCheckbox
          :model-value="isAllSelected(tab)"
          :indeterminate="isPartialSelected(tab)"
          @update:model-value="emit('toggle-select-all')"
        />
        <span class="text-muted text-xs">
          已选 {{ selectedCount(tab) }}/{{ allSelectable(tab).length }}
          <span v-if="tab.selectedPrefixes.size > 0" class="text-warning">
            （含 {{ tab.selectedPrefixes.size }} 个文件夹）
          </span>
        </span>
        <div class="flex-1" />
        <NuxtButton
          size="xs"
          color="primary"
          variant="outline"
          icon="i-lucide-upload"
          label="上传"
          @click="emit('upload')"
        />
        <NuxtButton
          v-if="selectedCount(tab) > 0"
          size="xs"
          color="info"
          variant="outline"
          icon="i-lucide-download"
          :label="`下载(${selectedCount(tab)})`"
          @click="emit('download')"
        />
        <NuxtButton
          v-if="selectedCount(tab) > 0"
          size="xs"
          color="error"
          variant="outline"
          icon="i-lucide-trash-2"
          :label="`删除(${selectedCount(tab)})`"
          @click="emit('delete')"
        />
        <NuxtButton
          v-if="selectedCount(tab) > 0"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-copy"
          label="复制"
          @click="emit('copy')"
        />
        <NuxtButton
          v-if="selectedCount(tab) > 0"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-folder-input"
          label="移动"
          @click="emit('move')"
        />
        <NuxtTooltip text="复制当前路径">
          <NuxtButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-clipboard-copy"
            @click="emit('copy-path', tab.currentPrefix)"
          />
        </NuxtTooltip>
        <NuxtTooltip text="刷新当前目录">
          <NuxtButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            :loading="tab.objectsLoading"
            @click="emit('refresh')"
          />
        </NuxtTooltip>
      </div>
    </div>

    <!-- 对象列表内容 -->
    <div class="flex min-h-0 flex-1 flex-col px-2 py-1" @scroll.passive.capture="onTableScroll">
      <div v-if="tab.objectsLoading" class="flex items-center justify-center py-12">
        <NuxtIcon name="i-lucide-loader-circle" class="text-muted size-6 animate-spin" />
      </div>
      <div v-else-if="tab.objectsError" class="flex flex-col items-center gap-2 py-12">
        <NuxtIcon name="i-lucide-cloud-off" class="text-error size-8" />
        <span class="text-error">{{ tab.objectsError }}</span>
        <NuxtButton
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          label="重试"
          @click="emit('refresh')"
        />
      </div>
      <div
        v-else-if="!tab.objects.length && !tab.commonPrefixes.length"
        class="flex flex-col items-center gap-3 py-16"
      >
        <NuxtIcon name="i-lucide-folder-open" class="text-muted size-10" />
        <p class="text-muted">此 bucket 下没有对象</p>
        <NuxtButton
          size="sm"
          color="primary"
          variant="outline"
          icon="i-lucide-upload"
          label="上传文件"
          @click="emit('upload')"
        />
      </div>

      <!-- 列表 -->
      <template v-else>
        <NuxtTable
          :data="tableData"
          :columns="browseColumns"
          :virtualize="{ estimateSize: 36 }"
          :ui="{
            tr: 'group',
            td: 'px-3 py-1.5 text-sm whitespace-nowrap',
            th: 'px-3 py-2 text-xs text-muted font-medium',
          }"
          sticky
          class="h-full"
        >
          <template #name-cell="{ row }">
            <div
              v-if="row.original.type === 'folder'"
              class="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
              @click="emit('navigate', row.original.key)"
            >
              <NuxtIcon name="i-lucide-folder" class="text-primary size-4 shrink-0" />
              <NuxtTooltip :text="row.original.key">
                <span class="truncate font-mono">{{ row.original.name }}</span>
              </NuxtTooltip>
            </div>
            <div v-else class="flex min-w-0 flex-1 items-center gap-2">
              <NuxtIcon :name="fileIcon(row.original.key)" class="text-muted size-4 shrink-0" />
              <NuxtTooltip :text="row.original.key">
                <span class="truncate font-mono">{{ row.original.name }}</span>
              </NuxtTooltip>
            </div>
          </template>

          <template #size-cell="{ row }">
            <span class="text-muted text-right text-xs">
              {{ row.original.size != null ? formatSize(row.original.size) : '-' }}
            </span>
          </template>

          <template #lastModified-cell="{ row }">
            <span class="text-muted text-right text-xs">
              {{ row.original.lastModified ? formatDate(row.original.lastModified) : '-' }}
            </span>
          </template>

          <template #actions-cell="{ row }">
            <div
              class="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
            >
              <template v-if="row.original.type === 'folder'">
                <NuxtTooltip text="下载">
                  <NuxtButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-download"
                    @click="emit('download', { type: 'folder', key: row.original.key })"
                  />
                </NuxtTooltip>
                <NuxtTooltip text="复制">
                  <NuxtButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-copy"
                    @click="emit('copy', { type: 'folder', key: row.original.key })"
                  />
                </NuxtTooltip>
                <NuxtTooltip text="移动">
                  <NuxtButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-folder-input"
                    @click="emit('move', { type: 'folder', key: row.original.key })"
                  />
                </NuxtTooltip>
                <NuxtTooltip text="复制路径">
                  <NuxtButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-clipboard-copy"
                    @click="emit('copy-path', row.original.key)"
                  />
                </NuxtTooltip>
                <NuxtTooltip text="删除">
                  <NuxtButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    icon="i-lucide-trash-2"
                    @click="emit('delete', { type: 'folder', key: row.original.key })"
                  />
                </NuxtTooltip>
              </template>
              <template v-else>
                <NuxtTooltip v-if="getPreviewType(row.original.key)" text="预览">
                  <NuxtButton
                    size="xs"
                    color="info"
                    variant="ghost"
                    icon="i-lucide-eye"
                    @click="emit('preview', row.original.key)"
                  />
                </NuxtTooltip>
                <NuxtTooltip text="下载">
                  <NuxtButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-download"
                    @click="emit('download', { type: 'object', key: row.original.key })"
                  />
                </NuxtTooltip>
                <NuxtTooltip text="复制">
                  <NuxtButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-copy"
                    @click="emit('copy', { type: 'object', key: row.original.key })"
                  />
                </NuxtTooltip>
                <NuxtTooltip text="移动">
                  <NuxtButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-folder-input"
                    @click="emit('move', { type: 'object', key: row.original.key })"
                  />
                </NuxtTooltip>
                <NuxtTooltip text="复制路径">
                  <NuxtButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-clipboard-copy"
                    @click="emit('copy-path', row.original.key)"
                  />
                </NuxtTooltip>
                <NuxtTooltip text="删除">
                  <NuxtButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    icon="i-lucide-trash-2"
                    @click="emit('delete', { type: 'object', key: row.original.key })"
                  />
                </NuxtTooltip>
              </template>
            </div>
          </template>
        </NuxtTable>

        <!-- 加载状态提示 -->
        <div class="text-muted shrink-0 py-2 text-center text-xs">
          <template v-if="tab.loadingMore">
            <NuxtIcon name="i-lucide-loader-circle" class="inline-block size-3 animate-spin" />
            加载中...
          </template>
          <template v-else-if="tab.hasMore"> 滚动加载更多 </template>
          <template v-else> 共 {{ tableData.length }} 个对象 </template>
        </div>
      </template>
    </div>
  </div>
</template>
