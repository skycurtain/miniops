<script setup lang="ts">
import type { InstanceGroup, MinioInstance } from '#shared/schemas/groups'
import type { ObjectInfo, BucketInfo } from '#shared/schemas/browse'
import { getPreviewType, type PreviewType } from '~/utils/browse'
import type { BrowseTab, RowTarget } from '~/pages/browse/types'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const toast = useToast()

// ==================== 数据 ====================
const { data: groups } = await useFetch<InstanceGroup[]>('/api/manage/groups', {
  default: () => [],
})

// ==================== 标签页 ====================
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

function restoreTabsFromRoute() {
  const tabsParam = route.query.tabs as string | undefined
  const activeParam = route.query.active as string | undefined
  // 实例管理跳转用 ?instance=<id>，与 tabs/active 同源恢复
  const instanceParam = route.query.instance as string | undefined

  const ids = tabsParam
    ? tabsParam.split(',').filter(Boolean)
    : instanceParam
      ? [instanceParam]
      : []
  if (!ids.length) return

  for (const id of ids) {
    const instance = findInstance(id)
    if (instance && !tabs.value.find((t) => t.instanceId === id)) {
      tabs.value.push(createTab(instance))
      const tab = tabs.value[tabs.value.length - 1]!
      loadBuckets(tab)
    }
  }

  const preferActive = activeParam || instanceParam
  if (preferActive && tabs.value.find((t) => t.instanceId === preferActive)) {
    activeTabId.value = preferActive
  } else if (tabs.value.length) {
    activeTabId.value = tabs.value[0]!.instanceId
  }

  // 把 instance 参数规范成 tabs/active，避免刷新后语义分叉
  if (instanceParam) syncTabsToRoute()
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

function navigateToPrefix(tab: BrowseTab, prefix: string) {
  tab.currentPrefix = prefix
  loadObjects(tab)
}

// ==================== 多选 ====================
function isAllSelected(tab: BrowseTab): boolean {
  const all = [...tab.commonPrefixes, ...tab.objects.map((o) => o.key)]
  return all.length > 0 && all.every((k) => tab.selectedKeys.has(k) || tab.selectedPrefixes.has(k))
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

function getEffectiveSelection(tab: BrowseTab) {
  if (singleTarget.value) {
    return singleTarget.value.type === 'object'
      ? { keys: new Set([singleTarget.value.key]), prefixes: new Set<string>() }
      : { keys: new Set<string>(), prefixes: new Set([singleTarget.value.key]) }
  }
  return { keys: tab.selectedKeys, prefixes: tab.selectedPrefixes }
}

// ==================== 预览 ====================
const previewOpen = ref(false)
const previewKey = ref('')
const previewType = ref<PreviewType>(null)
const previewObject = computed(() =>
  activeTab.value?.objects.find((o) => o.key === previewKey.value),
)

function openPreview(key: string) {
  const type = getPreviewType(key)
  if (!type) return
  previewKey.value = key
  previewType.value = type
  previewOpen.value = true
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
  if (activeTab.value && activeTab.value.selectedBucket) loadObjects(activeTab.value)
}

// ==================== 删除 ====================
const deleteModalOpen = ref(false)
const singleTarget = ref<RowTarget | null>(null)

function onDeleteComplete() {
  singleTarget.value = null
  const tab = activeTab.value
  if (!tab) return
  tab.selectedKeys = new Set()
  tab.selectedPrefixes = new Set()
  loadObjects(tab)
}

// ==================== 复制/移动弹窗 ====================
const copyMoveModalOpen = ref(false)
const copyMoveMode = ref<'copy' | 'move'>('copy')

function onDownloadTarget(target?: RowTarget) {
  if (!target) return downloadSelected()
  if (target.type === 'object') return downloadObject(target.key)
  singleTarget.value = { type: 'folder', key: target.key }
  downloadSelected()
  singleTarget.value = null
}

function onCopyTarget(target?: RowTarget) {
  singleTarget.value = target ?? null
  copyMoveMode.value = 'copy'
  copyMoveModalOpen.value = true
}

function onMoveTarget(target?: RowTarget) {
  singleTarget.value = target ?? null
  copyMoveMode.value = 'move'
  copyMoveModalOpen.value = true
}

function onDeleteTarget(target?: RowTarget) {
  if (target) singleTarget.value = target
  if (!activeTab.value) return
  deleteModalOpen.value = true
}

function onCopyMoveComplete(sourceInstanceId: string, targetInstanceId: string) {
  singleTarget.value = null
  // 刷新源/目标实例的 tab（复制/移动会同时改变两侧数据）
  for (const instanceId of new Set([sourceInstanceId, targetInstanceId])) {
    const tab = tabs.value.find((t) => t.instanceId === instanceId)
    if (tab && tab.selectedBucket) loadObjects(tab)
  }
}
</script>

<template>
  <NuxtDashboardPanel id="browse">
    <template #header>
      <AppNavbar title="实例访问" />
    </template>

    <template #body>
      <!-- 页头行（跨全宽） -->
      <div class="flex shrink-0 items-center justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="text-highlighted text-2xl font-bold">实例访问</h1>
          <p class="text-muted">浏览和管理 MinIO 实例中的对象</p>
        </div>
      </div>

      <div class="flex h-full min-h-0 gap-3">
        <!-- 左侧栏：实例树 -->
        <BrowseInstanceTree
          :groups="groups ?? []"
          :active-tab-id="activeTabId"
          :opened-instance-ids="openedInstanceIds"
          @open="openInstance"
        />

        <!-- 右侧栏：标签页区域 -->
        <div
          class="border-default bg-default flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border"
        >
          <BrowseTabBar
            :tabs="tabs"
            :active-tab-id="activeTabId"
            @switch="switchTab"
            @close="closeTab"
          />

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
              <BrowseBucketList
                v-if="!activeTab.selectedBucket"
                :instance-name="activeTab.instanceName"
                :buckets="activeTab.buckets"
                :loading="activeTab.bucketsLoading"
                :error="activeTab.bucketError"
                @select="(name: string) => selectBucket(activeTab!, name)"
                @retry="loadBuckets(activeTab!)"
              />

              <BrowseObjectPanel
                v-else
                :tab="activeTab"
                @navigate="(prefix: string) => navigateToPrefix(activeTab!, prefix)"
                @back="backToBucketList"
                @refresh="loadObjects(activeTab!)"
                @upload="openUpload"
                @download="onDownloadTarget"
                @delete="onDeleteTarget"
                @copy="onCopyTarget"
                @move="onMoveTarget"
                @preview="openPreview"
                @toggle-select-all="toggleSelectAll(activeTab!)"
                @toggle-select-key="(key: string) => toggleSelectKey(activeTab!, key)"
                @toggle-select-prefix="(prefix: string) => toggleSelectPrefix(activeTab!, prefix)"
                @load-more="loadMore(activeTab!)"
              />
            </template>
          </div>
        </div>
      </div>

      <!-- 预览抽屉 -->
      <BrowsePreviewModal
        v-model:open="previewOpen"
        :object-key="previewKey"
        :preview-type="previewType"
        :object="previewObject ?? null"
        :instance-id="activeTab?.instanceId ?? ''"
        :bucket="activeTab?.selectedBucket ?? ''"
        :instance-name="activeTab?.instanceName ?? ''"
      />

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
      <BrowseDeleteModal
        v-model:open="deleteModalOpen"
        :instance-id="activeTab?.instanceId ?? ''"
        :bucket="activeTab?.selectedBucket ?? ''"
        :prefix="activeTab?.currentPrefix ?? ''"
        :target="singleTarget"
        :selected-keys="[...(activeTab?.selectedKeys ?? [])]"
        :selected-prefixes="[...(activeTab?.selectedPrefixes ?? [])]"
        @complete="onDeleteComplete"
      />
    </template>
  </NuxtDashboardPanel>
</template>
