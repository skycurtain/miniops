<script setup lang="ts">
import { h } from 'vue'
import type { TreeItem } from '@nuxt/ui'
import type { TableColumn } from '@nuxt/ui'
import type { InstanceGroup, MinioInstance } from '#shared/schemas/groups'
import type { ObjectInfo, BucketInfo } from '#shared/schemas/browse'
import {
  formatSize,
  formatDate,
  fileIcon,
  getPreviewType,
  displayName,
  type PreviewType,
} from '~/utils/browse'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const toast = useToast()

// ==================== 数据 ====================
const { data: groups } = await useFetch<InstanceGroup[]>('/api/manage/groups', {
  default: () => [],
})

// ==================== 实例树 ====================
interface InstanceTreeItem extends TreeItem {
  instanceId?: string
  children?: InstanceTreeItem[]
}

const treeItems = computed<InstanceTreeItem[]>(() =>
  (groups.value ?? []).map((g) => ({
    label: g.name,
    icon: 'i-lucide-folder',
    defaultExpanded: true,
    children: g.instances
      .filter((i) => i.enabled)
      .map((i) => ({
        label: i.name,
        icon: 'i-lucide-server',
        instanceId: i.id,
        onSelect: () => openInstance(i),
      })),
  })),
)

const treeSelected = computed({
  get: () => {
    if (!activeTabId.value) return undefined
    for (const g of treeItems.value) {
      const found = g.children?.find((c) => c.instanceId === activeTabId.value)
      if (found) return found
    }
    return undefined
  },
  set: (val) => {
    if (val && (val as InstanceTreeItem).instanceId) {
      activeTabId.value = (val as InstanceTreeItem).instanceId!
      syncTabsToRoute()
    }
  },
})

// ==================== 标签页 ====================
interface BrowseTab {
  instanceId: string
  instanceName: string
  buckets: BucketInfo[]
  bucketsLoading: boolean
  bucketError: string
  selectedBucket: string
  objects: ObjectInfo[]
  commonPrefixes: string[]
  currentPrefix: string
  objectsLoading: boolean
  objectsError: string
  hasMore: boolean
  loadingMore: boolean
  continuationToken?: string
  selectedKeys: Set<string>
  selectedPrefixes: Set<string>
}

/** Table 行数据：文件夹和对象合并 */
interface BrowseTableRow {
  type: 'folder' | 'object'
  key: string
  name: string
  size?: number
  lastModified?: string
}

const tabs = ref<BrowseTab[]>([])
const activeTabId = ref<string>('')

function createTab(instance: MinioInstance): BrowseTab {
  return {
    instanceId: instance.id,
    instanceName: instance.name,
    buckets: [],
    bucketsLoading: false,
    bucketError: '',
    selectedBucket: '',
    objects: [],
    commonPrefixes: [],
    currentPrefix: '',
    objectsLoading: false,
    objectsError: '',
    hasMore: false,
    loadingMore: false,
    selectedKeys: new Set(),
    selectedPrefixes: new Set(),
  }
}

const activeTab = computed(() => tabs.value.find((t) => t.instanceId === activeTabId.value))
const openedInstanceIds = computed(() => new Set(tabs.value.map((t) => t.instanceId)))

function syncTabsToRoute() {
  const ids = tabs.value.map((t) => t.instanceId)
  router.replace({
    query: {
      ...route.query,
      tabs: ids.length ? ids.join(',') : undefined,
      active: activeTabId.value || undefined,
    },
  })
}

function findInstance(id: string): MinioInstance | undefined {
  for (const g of groups.value ?? []) {
    const inst = g.instances.find((i) => i.id === id && i.enabled)
    if (inst) return inst
  }
  return undefined
}

function openInstance(instance: MinioInstance) {
  const existing = tabs.value.find((t) => t.instanceId === instance.id)
  if (existing) {
    activeTabId.value = instance.id
    syncTabsToRoute()
    return
  }
  tabs.value.push(createTab(instance))
  activeTabId.value = instance.id
  const tab = tabs.value[tabs.value.length - 1]!
  loadBuckets(tab)
  syncTabsToRoute()
}

function closeTab(instanceId: string) {
  const idx = tabs.value.findIndex((t) => t.instanceId === instanceId)
  if (idx === -1) return
  tabs.value.splice(idx, 1)
  if (activeTabId.value === instanceId) {
    activeTabId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.instanceId ?? ''
  }
  syncTabsToRoute()
}

function switchTab(instanceId: string) {
  activeTabId.value = instanceId
  syncTabsToRoute()
}

/** 鼠标滚轮横向滚动标签栏（触摸板水平滚动时尊重原生行为） */
function onTabWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement
  if (e.deltaX !== 0) return
  el.scrollLeft += e.deltaY
}

function restoreTabsFromRoute() {
  const tabsParam = route.query.tabs as string | undefined
  const activeParam = route.query.active as string | undefined
  if (!tabsParam) return
  const ids = tabsParam.split(',').filter(Boolean)
  for (const id of ids) {
    const instance = findInstance(id)
    if (instance && !tabs.value.find((t) => t.instanceId === id)) {
      tabs.value.push(createTab(instance))
      const tab = tabs.value[tabs.value.length - 1]!
      loadBuckets(tab)
    }
  }
  if (activeParam && tabs.value.find((t) => t.instanceId === activeParam)) {
    activeTabId.value = activeParam
  } else if (tabs.value.length) {
    activeTabId.value = tabs.value[0]!.instanceId
  }
}

restoreTabsFromRoute()

// ==================== Bucket 加载 ====================
async function loadBuckets(tab: BrowseTab) {
  tab.bucketsLoading = true
  tab.bucketError = ''
  tab.buckets = []
  tab.selectedBucket = ''
  try {
    const res = await $fetch<{ buckets: BucketInfo[]; error?: string }>('/api/browse/buckets', {
      query: { instanceId: tab.instanceId },
    })
    if (res.error) {
      tab.bucketError = res.error
    } else {
      tab.buckets = res.buckets
    }
  } catch (e: unknown) {
    tab.bucketError = e instanceof Error ? e.message : '加载失败'
  } finally {
    tab.bucketsLoading = false
  }
}

function selectBucket(tab: BrowseTab, bucket: string) {
  tab.selectedBucket = bucket
  tab.currentPrefix = ''
  tab.selectedKeys = new Set()
  tab.selectedPrefixes = new Set()
  loadObjects(tab)
}

/** 返回 bucket 列表视图 */
function backToBucketList() {
  const tab = activeTab.value
  if (!tab) return
  tab.selectedBucket = ''
  tab.objects = []
  tab.commonPrefixes = []
}

// ==================== 对象列表加载 ====================
async function loadObjects(tab: BrowseTab) {
  if (!tab.selectedBucket) return
  tab.objectsLoading = true
  tab.objectsError = ''
  tab.objects = []
  tab.commonPrefixes = []
  tab.continuationToken = undefined
  tab.hasMore = false
  tab.selectedKeys = new Set()
  tab.selectedPrefixes = new Set()
  try {
    const res = await $fetch<{
      objects: ObjectInfo[]
      commonPrefixes: string[]
      isTruncated: boolean
      continuationToken?: string
    }>('/api/browse/objects/list', {
      method: 'POST',
      body: {
        instanceId: tab.instanceId,
        bucket: tab.selectedBucket,
        prefix: tab.currentPrefix,
      },
    })
    tab.objects = res.objects
    tab.commonPrefixes = res.commonPrefixes
    tab.hasMore = res.isTruncated
    tab.continuationToken = res.continuationToken
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    tab.objectsError = err?.data?.message || err?.message || '加载失败'
  } finally {
    tab.objectsLoading = false
  }
}

async function loadMore(tab: BrowseTab) {
  if (!tab.hasMore || tab.loadingMore || !tab.continuationToken) return
  tab.loadingMore = true
  try {
    const res = await $fetch<{
      objects: ObjectInfo[]
      commonPrefixes: string[]
      isTruncated: boolean
      continuationToken?: string
    }>('/api/browse/objects/list', {
      method: 'POST',
      body: {
        instanceId: tab.instanceId,
        bucket: tab.selectedBucket,
        prefix: tab.currentPrefix,
        continuationToken: tab.continuationToken,
      },
    })
    tab.objects.push(...res.objects)
    tab.commonPrefixes.push(...res.commonPrefixes)
    tab.hasMore = res.isTruncated
    tab.continuationToken = res.continuationToken
  } catch {
    toast.add({ title: '加载更多失败', color: 'error' })
  } finally {
    tab.loadingMore = false
  }
}

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

function navigateToPrefix(tab: BrowseTab, prefix: string) {
  tab.currentPrefix = prefix
  loadObjects(tab)
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

function toggleSelectAll(tab: BrowseTab) {
  if (isAllSelected(tab)) {
    tab.selectedKeys = new Set()
    tab.selectedPrefixes = new Set()
  } else {
    tab.selectedKeys = new Set(tab.objects.map((o) => o.key))
    tab.selectedPrefixes = new Set(tab.commonPrefixes)
  }
}

function toggleSelectKey(tab: BrowseTab, key: string) {
  const set = new Set(tab.selectedKeys)
  if (set.has(key)) set.delete(key)
  else set.add(key)
  tab.selectedKeys = set
}

function toggleSelectPrefix(tab: BrowseTab, prefix: string) {
  const set = new Set(tab.selectedPrefixes)
  if (set.has(prefix)) set.delete(prefix)
  else set.add(prefix)
  tab.selectedPrefixes = set
}

// ==================== Table 数据和列定义 ====================
const tableData = computed<BrowseTableRow[]>(() => {
  const tab = activeTab.value
  if (!tab) return []
  const folders: BrowseTableRow[] = tab.commonPrefixes.map(cp => ({
    type: 'folder',
    key: cp,
    name: cp.replace(tab.currentPrefix, ''),
  }))
  const objects: BrowseTableRow[] = tab.objects.map(obj => ({
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
      const tab = activeTab.value
      if (!tab) return h(NuxtCheckboxComponent, { disabled: true })
      return h(NuxtCheckboxComponent, {
        modelValue: isPartialSelected(tab) ? 'indeterminate' : isAllSelected(tab),
        'onUpdate:modelValue': () => toggleSelectAll(tab),
      })
    },
    cell: ({ row }) => {
      const tab = activeTab.value
      if (!tab) return null
      const isSelected = row.original.type === 'folder'
        ? tab.selectedPrefixes.has(row.original.key)
        : tab.selectedKeys.has(row.original.key)
      return h(NuxtCheckboxComponent, {
        modelValue: isSelected,
        'onUpdate:modelValue': () => {
          if (row.original.type === 'folder')
            toggleSelectPrefix(tab, row.original.key)
          else
            toggleSelectKey(tab, row.original.key)
        },
      })
    },
  },
  {
    id: 'name',
    header: '名称',
  },
  {
    id: 'size',
    header: '大小',
  },
  {
    id: 'lastModified',
    header: '修改时间',
  },
  {
    id: 'actions',
    header: '',
  },
]

// ==================== 无限滚动 ====================
function onTableScroll(e: Event) {
  const tab = activeTab.value
  if (!tab || !tab.hasMore || tab.loadingMore) return
  const el = e.target as HTMLElement
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
    loadMore(tab)
  }
}

// ==================== 预览 ====================
const previewOpen = ref(false)
const previewKey = ref('')
const previewType = ref<PreviewType>(null)
const textContent = ref('')
const textLoading = ref(false)
const textError = ref('')
const previewObject = computed(() =>
  activeTab.value?.objects.find((o) => o.key === previewKey.value),
)

function buildPreviewUrl(key: string): string {
  const params = new URLSearchParams({
    instanceId: activeTab.value?.instanceId ?? '',
    bucket: activeTab.value?.selectedBucket ?? '',
    key,
    inline: '1',
  })
  return `/api/browse/objects/download?${params.toString()}`
}

function openPreview(key: string) {
  const type = getPreviewType(key)
  if (!type) return
  previewKey.value = key
  previewType.value = type
  previewOpen.value = true
  textContent.value = ''
  textError.value = ''
  if (type === 'text') {
    fetchTextContent(key)
  }
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

// ==================== 下载 ====================
function downloadObject(key: string) {
  const params = new URLSearchParams({
    instanceId: activeTab.value?.instanceId ?? '',
    bucket: activeTab.value?.selectedBucket ?? '',
    key,
  })
  const a = document.createElement('a')
  a.href = `/api/browse/objects/download?${params.toString()}`
  a.download = key.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

async function downloadSelected() {
  const tab = activeTab.value
  if (!tab) return
  const { keys, prefixes } = getEffectiveSelection(tab)
  const count = keys.size + prefixes.size
  if (count > 1000) {
    toast.add({ title: `选中对象过多（${count} 个），上限 1000 个`, color: 'error' })
    return
  }
  if (count === 1 && prefixes.size === 0) {
    downloadObject([...keys][0]!)
    return
  }
  try {
    const blob = await $fetch<Blob>('/api/browse/objects/download-batch', {
      method: 'POST',
      body: {
        instanceId: tab.instanceId,
        bucket: tab.selectedBucket,
        keys: [...keys],
        prefixes: [...prefixes],
      },
      responseType: 'blob',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `miniops-download-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.add({ title: `已下载 ${count} 项（ZIP 打包）`, color: 'success' })
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    toast.add({
      title: '下载失败',
      description: err?.data?.message || err?.message || '未知错误',
      color: 'error',
    })
  }
}

// ==================== 上传弹窗 ====================
const uploadModalOpen = ref(false)

function openUpload() {
  uploadModalOpen.value = true
}

function onUploadComplete() {
  if (activeTab.value && activeTab.value.selectedBucket) {
    loadObjects(activeTab.value)
  }
}

// ==================== 删除确认 ====================
type DeletePhase = 'idle' | 'scanning' | 'confirm' | 'deleting' | 'done'
const deleteModalOpen = ref(false)
const deletePhase = ref<DeletePhase>('idle')
const singleTarget = ref<{ type: 'object' | 'folder'; key: string } | null>(null)

interface DeleteItem {
  key: string
  name: string
  status: 'pending' | 'deleted' | 'failed'
  error?: string
}
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
        return h('span', { class: 'text-error flex items-center gap-1 justify-end text-xs', title: item.error }, [
          h(resolveComponent('NuxtIcon'), { name: 'i-lucide-x', class: 'size-3' }),
          item.error || '失败',
        ])
      }
      if (deletePhase.value === 'deleting') {
        return h('span', { class: 'text-primary flex items-center gap-1 justify-end text-xs' }, [
          h(resolveComponent('NuxtIcon'), { name: 'i-lucide-loader-circle', class: 'size-3 animate-spin' }),
          '删除中',
        ])
      }
      return h('span', { class: 'text-muted text-xs' }, '-')
    },
  },
]

const deleteIsRunning = computed(() =>
  deletePhase.value === 'scanning' || deletePhase.value === 'deleting',
)

function getEffectiveSelection(tab: BrowseTab) {
  if (singleTarget.value) {
    return singleTarget.value.type === 'object'
      ? { keys: new Set([singleTarget.value.key]), prefixes: new Set<string>() }
      : { keys: new Set<string>(), prefixes: new Set([singleTarget.value.key]) }
  }
  return { keys: tab.selectedKeys, prefixes: tab.selectedPrefixes }
}

async function openDeleteConfirm() {
  const tab = activeTab.value
  if (!tab) return
  deletePhase.value = 'scanning'
  deleteItems.value = []
  deleteSummary.value = { total: 0, success: 0, failed: 0 }
  deleteModalOpen.value = true

  const { keys, prefixes } = getEffectiveSelection(tab)
  try {
    const res = await $fetch<{ items: { key: string; name: string }[]; total: number }>(
      '/api/browse/objects/delete/preview',
      {
        method: 'POST',
        body: {
          instanceId: tab.instanceId,
          bucket: tab.selectedBucket,
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
    deleteModalOpen.value = false
    deletePhase.value = 'idle'
  }
}

async function onConfirmDelete() {
  const tab = activeTab.value
  if (!tab) return
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
            instanceId: tab.instanceId,
            bucket: tab.selectedBucket,
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
    singleTarget.value = null
    tab.selectedKeys = new Set()
    tab.selectedPrefixes = new Set()
    loadObjects(tab)
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
  deleteModalOpen.value = false
}

watch(deleteModalOpen, (open) => {
  if (!open) {
    deletePhase.value = 'idle'
    deleteItems.value = []
    deleteSummary.value = { total: 0, success: 0, failed: 0 }
  }
})

// ==================== 复制/移动弹窗 ====================
const copyMoveModalOpen = ref(false)
const copyMoveMode = ref<'copy' | 'move'>('copy')

function openCopy() {
  singleTarget.value = null
  copyMoveMode.value = 'copy'
  copyMoveModalOpen.value = true
}

function openMove() {
  singleTarget.value = null
  copyMoveMode.value = 'move'
  copyMoveModalOpen.value = true
}

function openSingleCopy(key: string) {
  singleTarget.value = { type: 'object', key }
  copyMoveMode.value = 'copy'
  copyMoveModalOpen.value = true
}

function openSingleMove(key: string) {
  singleTarget.value = { type: 'object', key }
  copyMoveMode.value = 'move'
  copyMoveModalOpen.value = true
}

function openSingleDelete(key: string) {
  singleTarget.value = { type: 'object', key }
  openDeleteConfirm()
}

function downloadSinglePrefix(prefix: string) {
  singleTarget.value = { type: 'folder', key: prefix }
  downloadSelected()
  singleTarget.value = null
}

function openSinglePrefixCopy(prefix: string) {
  singleTarget.value = { type: 'folder', key: prefix }
  copyMoveMode.value = 'copy'
  copyMoveModalOpen.value = true
}

function openSinglePrefixMove(prefix: string) {
  singleTarget.value = { type: 'folder', key: prefix }
  copyMoveMode.value = 'move'
  copyMoveModalOpen.value = true
}

function openSinglePrefixDelete(prefix: string) {
  singleTarget.value = { type: 'folder', key: prefix }
  openDeleteConfirm()
}

function onCopyMoveComplete() {
  singleTarget.value = null
  if (activeTab.value && activeTab.value.selectedBucket) {
    loadObjects(activeTab.value)
  }
}
</script>

<template>
  <NuxtDashboardPanel id="browse">
    <template #header>
      <AppNavbar title="实例访问" />
    </template>

    <template #body>
      <div class="flex h-full min-h-0 gap-3">
        <!-- 左侧栏：实例树 -->
        <div
          class="border-default bg-default flex shrink-0 flex-col overflow-hidden rounded-lg border"
          style="width: 260px"
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

        <!-- 右侧栏：标签页区域 -->
        <div
          class="border-default bg-default flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border"
        >
          <!-- 标签栏 -->
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
              @click="switchTab(tab.instanceId)"
            >
              <NuxtIcon
                name="i-lucide-server"
                class="size-4 shrink-0"
                :class="activeTabId === tab.instanceId ? 'text-primary' : 'text-muted'"
              />
              <span class="truncate" style="width: 120px">{{ tab.instanceName }}</span>
              <span
                class="hover:bg-elevated flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md"
                @click.stop="closeTab(tab.instanceId)"
              >
                <NuxtIcon name="i-lucide-x" class="size-3.5" />
              </span>
            </button>
          </div>

          <!-- 标签页内容 -->
          <div class="min-h-0 flex-1 overflow-hidden">
            <!-- 空状态 -->
            <div v-if="!activeTab" class="flex h-full items-center justify-center">
              <div class="flex flex-col items-center gap-3 text-center">
                <NuxtIcon name="i-lucide-folder-open" class="text-dimmed size-12" />
                <p class="text-muted">请从左侧选择一个实例</p>
              </div>
            </div>

            <!-- 实例标签页内容 -->
            <template v-else>
              <!-- Bucket 加载失败 -->
              <div
                v-if="activeTab.bucketError && !activeTab.selectedBucket"
                class="flex h-full items-center justify-center"
              >
                <div class="flex flex-col items-center gap-3 text-center">
                  <NuxtIcon name="i-lucide-cloud-off" class="text-error size-10" />
                  <p class="text-error">{{ activeTab.bucketError }}</p>
                  <NuxtButton
                    size="sm"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-refresh-cw"
                    label="重试"
                    @click="loadBuckets(activeTab)"
                  />
                </div>
              </div>

              <!-- Bucket 列表 -->
              <div v-else-if="!activeTab.selectedBucket" class="flex h-full flex-col">
                <div class="border-default flex shrink-0 items-center gap-2 border-b px-4 py-3">
                  <NuxtIcon name="i-lucide-server" class="text-primary size-5" />
                  <span class="text-highlighted font-semibold">{{ activeTab.instanceName }}</span>
                  <NuxtBadge color="neutral" variant="subtle" size="sm">
                    {{ activeTab.buckets.length }} 个 bucket
                  </NuxtBadge>
                </div>
                <div class="min-h-0 flex-1 overflow-y-auto p-4">
                  <div
                    v-if="activeTab.bucketsLoading"
                    class="flex items-center justify-center py-12"
                  >
                    <NuxtIcon
                      name="i-lucide-loader-circle"
                      class="text-muted size-6 animate-spin"
                    />
                  </div>
                  <div
                    v-else-if="!activeTab.buckets.length"
                    class="flex flex-col items-center gap-3 py-16"
                  >
                    <NuxtIcon name="i-lucide-database-zap" class="text-muted size-10" />
                    <p class="text-muted">该实例下没有可用的 bucket</p>
                  </div>
                  <div v-else class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <button
                      v-for="b in activeTab.buckets"
                      :key="b.name"
                      class="border-default hover:border-primary hover:bg-primary/5 group flex cursor-pointer items-center gap-3 rounded-lg border p-4 text-left transition-colors"
                      @click="selectBucket(activeTab, b.name)"
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

              <!-- 对象列表 -->
              <div v-else class="flex h-full flex-col">
                <div class="border-default shrink-0 border-b px-4 py-2">
                  <!-- 面包屑 -->
                  <div class="flex flex-wrap items-center gap-1 text-sm">
                    <button class="text-muted hover:text-primary" @click="backToBucketList">
                      {{ activeTab.instanceName }}
                    </button>
                    <template v-for="(crumb, idx) in getBreadcrumbs(activeTab)" :key="idx">
                      <NuxtIcon name="i-lucide-chevron-right" class="text-muted size-3" />
                      <button
                        class="font-mono"
                        :class="
                          idx === getBreadcrumbs(activeTab).length - 1
                            ? 'text-highlighted font-semibold'
                            : 'text-muted hover:text-primary'
                        "
                        @click="navigateToPrefix(activeTab, crumb.prefix)"
                      >
                        {{ crumb.label }}
                      </button>
                    </template>
                  </div>

                  <!-- 工具栏 -->
                  <div class="mt-2 flex items-center gap-2">
                    <NuxtCheckbox
                      :model-value="isAllSelected(activeTab)"
                      :indeterminate="isPartialSelected(activeTab)"
                      @update:model-value="toggleSelectAll(activeTab)"
                    />
                    <span class="text-muted text-xs">
                      已选 {{ selectedCount(activeTab) }}/{{ allSelectable(activeTab).length }}
                      <span v-if="activeTab.selectedPrefixes.size > 0" class="text-warning">
                        （含 {{ activeTab.selectedPrefixes.size }} 个文件夹）
                      </span>
                    </span>
                    <div class="flex-1" />
                    <NuxtButton
                      size="xs"
                      color="primary"
                      variant="outline"
                      icon="i-lucide-upload"
                      label="上传"
                      @click="openUpload"
                    />
                    <NuxtButton
                      v-if="selectedCount(activeTab) > 0"
                      size="xs"
                      color="info"
                      variant="outline"
                      icon="i-lucide-download"
                      :label="`下载(${selectedCount(activeTab)})`"
                      @click="downloadSelected"
                    />
                    <NuxtButton
                      v-if="selectedCount(activeTab) > 0"
                      size="xs"
                      color="error"
                      variant="outline"
                      icon="i-lucide-trash-2"
                      :label="`删除(${selectedCount(activeTab)})`"
                      @click="openDeleteConfirm"
                    />
                    <NuxtButton
                      v-if="selectedCount(activeTab) > 0"
                      size="xs"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-copy"
                      label="复制"
                      @click="openCopy"
                    />
                    <NuxtButton
                      v-if="selectedCount(activeTab) > 0"
                      size="xs"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-folder-input"
                      label="移动"
                      @click="openMove"
                    />
                    <NuxtTooltip text="刷新当前目录">
                      <NuxtButton
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-refresh-cw"
                        :loading="activeTab.objectsLoading"
                        @click="loadObjects(activeTab)"
                      />
                    </NuxtTooltip>
                  </div>
                </div>

                <!-- 对象列表内容 -->
                <div class="min-h-0 flex-1 flex flex-col px-2 py-1" @scroll.passive.capture="onTableScroll">
                  <div
                    v-if="activeTab.objectsLoading"
                    class="flex items-center justify-center py-12"
                  >
                    <NuxtIcon
                      name="i-lucide-loader-circle"
                      class="text-muted size-6 animate-spin"
                    />
                  </div>
                  <div
                    v-else-if="activeTab.objectsError"
                    class="flex flex-col items-center gap-2 py-12"
                  >
                    <NuxtIcon name="i-lucide-cloud-off" class="text-error size-8" />
                    <span class="text-error">{{ activeTab.objectsError }}</span>
                    <NuxtButton
                      size="sm"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-refresh-cw"
                      label="重试"
                      @click="loadObjects(activeTab)"
                    />
                  </div>
                  <div
                    v-else-if="!activeTab.objects.length && !activeTab.commonPrefixes.length"
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
                      @click="openUpload"
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
                          @click="navigateToPrefix(activeTab!, row.original.key)"
                        >
                          <NuxtIcon name="i-lucide-folder" class="text-primary size-4 shrink-0" />
                          <span class="truncate font-mono">{{ row.original.name }}</span>
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
                        <div class="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <template v-if="row.original.type === 'folder'">
                            <NuxtTooltip text="下载">
                              <NuxtButton
                                size="xs"
                                color="neutral"
                                variant="ghost"
                                icon="i-lucide-download"
                                @click="downloadSinglePrefix(row.original.key)"
                              />
                            </NuxtTooltip>
                            <NuxtTooltip text="复制">
                              <NuxtButton
                                size="xs"
                                color="neutral"
                                variant="ghost"
                                icon="i-lucide-copy"
                                @click="openSinglePrefixCopy(row.original.key)"
                              />
                            </NuxtTooltip>
                            <NuxtTooltip text="移动">
                              <NuxtButton
                                size="xs"
                                color="neutral"
                                variant="ghost"
                                icon="i-lucide-folder-input"
                                @click="openSinglePrefixMove(row.original.key)"
                              />
                            </NuxtTooltip>
                            <NuxtTooltip text="删除">
                              <NuxtButton
                                size="xs"
                                color="error"
                                variant="ghost"
                                icon="i-lucide-trash-2"
                                @click="openSinglePrefixDelete(row.original.key)"
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
                                @click="openPreview(row.original.key)"
                              />
                            </NuxtTooltip>
                            <NuxtTooltip text="下载">
                              <NuxtButton
                                size="xs"
                                color="neutral"
                                variant="ghost"
                                icon="i-lucide-download"
                                @click="downloadObject(row.original.key)"
                              />
                            </NuxtTooltip>
                            <NuxtTooltip text="复制">
                              <NuxtButton
                                size="xs"
                                color="neutral"
                                variant="ghost"
                                icon="i-lucide-copy"
                                @click="openSingleCopy(row.original.key)"
                              />
                            </NuxtTooltip>
                            <NuxtTooltip text="移动">
                              <NuxtButton
                                size="xs"
                                color="neutral"
                                variant="ghost"
                                icon="i-lucide-folder-input"
                                @click="openSingleMove(row.original.key)"
                              />
                            </NuxtTooltip>
                            <NuxtTooltip text="删除">
                              <NuxtButton
                                size="xs"
                                color="error"
                                variant="ghost"
                                icon="i-lucide-trash-2"
                                @click="openSingleDelete(row.original.key)"
                              />
                            </NuxtTooltip>
                          </template>
                        </div>
                      </template>
                    </NuxtTable>

                    <!-- 加载状态提示 -->
                    <div class="text-muted shrink-0 py-2 text-center text-xs">
                      <template v-if="activeTab.loadingMore">
                        <NuxtIcon name="i-lucide-loader-circle" class="size-3 animate-spin inline-block" />
                        加载中...
                      </template>
                      <template v-else-if="activeTab.hasMore">
                        滚动加载更多
                      </template>
                      <template v-else>
                        共 {{ tableData.length }} 个对象
                      </template>
                    </div>
                  </template>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 预览抽屉 -->
      <NuxtSlideover
        v-model:open="previewOpen"
        title="对象预览"
        side="right"
        :ui="{ content: 'w-full max-w-2xl sm:max-w-3xl' }"
      >
        <template #body>
          <div class="flex h-full flex-col gap-3">
            <div class="border-default flex items-start justify-between gap-4 border-b pb-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <NuxtIcon
                    v-if="previewKey"
                    :name="fileIcon(previewKey)"
                    class="text-muted size-4 shrink-0"
                  />
                  <span class="text-highlighted truncate font-mono font-medium">
                    {{ previewKey.split('/').pop() }}
                  </span>
                </div>
                <div v-if="previewObject" class="text-muted mt-1 text-xs">
                  {{ formatSize(previewObject.size) }} ·
                  {{ formatDate(previewObject.lastModified) }}
                </div>
                <div class="text-muted mt-0.5 text-xs">
                  {{ activeTab?.instanceName }} / {{ activeTab?.selectedBucket }}
                </div>
              </div>
              <NuxtButton
                size="sm"
                color="primary"
                variant="outline"
                icon="i-lucide-download"
                label="下载"
                @click="downloadObject(previewKey)"
              />
            </div>

            <div class="min-h-0 flex-1 overflow-auto">
              <div
                v-if="previewType === 'image'"
                class="bg-elevated/50 flex min-h-75 items-center justify-center rounded-md"
              >
                <img
                  :src="buildPreviewUrl(previewKey)"
                  :alt="previewKey"
                  class="max-h-[70vh] max-w-full object-contain"
                />
              </div>

              <div
                v-else-if="previewType === 'video'"
                class="bg-elevated/50 flex min-h-75 items-center justify-center rounded-md"
              >
                <video
                  :src="buildPreviewUrl(previewKey)"
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
                <span class="text-muted text-sm">{{ previewKey.split('/').pop() }}</span>
                <audio :src="buildPreviewUrl(previewKey)" controls>您的浏览器不支持音频播放</audio>
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

      <!-- 上传弹窗 -->
      <BrowseUploadModal
        v-model:open="uploadModalOpen"
        :instance-id="activeTab?.instanceId ?? ''"
        :instance-name="activeTab?.instanceName ?? ''"
        :bucket="activeTab?.selectedBucket ?? ''"
        :prefix="activeTab?.currentPrefix ?? ''"
        @complete="onUploadComplete"
      />

      <!-- 复制/移动弹窗 -->
      <BrowseCopyMoveModal
        v-model:open="copyMoveModalOpen"
        :mode="copyMoveMode"
        :groups="groups ?? []"
        :source-instance-id="activeTab?.instanceId ?? ''"
        :source-instance-name="activeTab?.instanceName ?? ''"
        :source-bucket="activeTab?.selectedBucket ?? ''"
        :source-prefix="activeTab?.currentPrefix ?? ''"
        :selected-keys="activeTab?.selectedKeys ?? new Set<string>()"
        :selected-prefixes="activeTab?.selectedPrefixes ?? new Set<string>()"
        :single-target="singleTarget"
        @complete="onCopyMoveComplete"
      />

      <!-- 删除确认弹窗 -->
      <NuxtModal
        v-model:open="deleteModalOpen"
        title="确认删除"
        :dismissible="false"
        :close="!deleteIsRunning"
        :ui="{ content: 'w-[calc(100vw-2rem)] max-w-2xl' }"
      >
        <template #body>
          <!-- 统计中 -->
          <div v-if="deletePhase === 'scanning'" class="flex items-center gap-2 py-8 justify-center">
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
                  :style="{ width: `${deleteSummary.total > 0 ? ((deleteSummary.success + deleteSummary.failed) / deleteSummary.total) * 100 : 0}%` }"
                />
              </div>
              <span class="text-muted text-xs">{{ deleteSummary.success + deleteSummary.failed }}/{{ deleteSummary.total }}</span>
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
  </NuxtDashboardPanel>
</template>
