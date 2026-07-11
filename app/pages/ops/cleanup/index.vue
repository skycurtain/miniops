<script setup lang="ts">
import ConfirmDialog from '~/components/ConfirmDialog.vue'

// ---------- 类型定义（与后端对齐） ----------
interface MinioInstance {
  id: string
  groupId: string
  name: string
  endpoint: string
  enabled: boolean
}
interface InstanceGroup {
  id: string
  name: string
  description?: string
  instances: MinioInstance[]
  isDefault?: boolean
  createdAt: string
  updatedAt: string
}
interface ObjectInfo {
  key: string
  size: number
  lastModified: string
  etag?: string
}
interface CleanupResult {
  instanceId: string
  instanceName: string
  target: string
  targetType: 'object' | 'prefix'
  status: 'success' | 'failed'
  error?: string
  deletedCount?: number
  duration?: number
}

// ---------- 数据获取 ----------
const { data: groups } = await useFetch<InstanceGroup[]>('/api/groups', { default: () => [] })
const cleanup = useCleanup()

// ---------- 辅助函数 ----------
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatDate(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function displayName(key: string): string {
  const prefix = cleanup.prefix.value
  const stripped = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
  return stripped.split('/').pop() || key
}

function fileIcon(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() || ''
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return 'i-lucide-file-image'
  if (['json'].includes(ext)) return 'i-lucide-file-json'
  if (['zip', 'gz', 'tar', 'tgz', 'rar', '7z'].includes(ext)) return 'i-lucide-file-archive'
  if (['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext)) return 'i-lucide-file-video'
  if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) return 'i-lucide-file-audio'
  if (['txt', 'csv', 'xml', 'log', 'md'].includes(ext)) return 'i-lucide-file-text'
  if (['js', 'ts', 'mjs', 'css', 'html', 'htm'].includes(ext)) return 'i-lucide-file-code'
  return 'i-lucide-file'
}

/** 前缀清洗（复用 sanitizeObjectKey 规则） */
function sanitizePrefix(p: string): string {
  const cleaned = p
    .replace(/\\/g, '/')
    .split('/')
    .map(seg => seg.replace(/^\.+/, ''))
    .filter(seg => seg.length > 0 && seg !== '..')
    .join('/')
  return cleaned ? `${cleaned}/` : ''
}

// ---------- 1. 实例选择（复用分发页模式） ----------
const expanded = ref<Record<string, boolean>>({})

function isInstanceSelected(inst: MinioInstance) { return cleanup.selectedInstanceIds.value.has(inst.id) }
function toggleInstance(inst: MinioInstance) {
  const set = new Set(cleanup.selectedInstanceIds.value)
  set.has(inst.id) ? set.delete(inst.id) : set.add(inst.id)
  cleanup.selectedInstanceIds.value = set
}
function isGroupAllSelected(g: InstanceGroup) {
  const en = g.instances.filter(i => i.enabled)
  return en.length > 0 && en.every(i => isInstanceSelected(i))
}
function isGroupPartialSelected(g: InstanceGroup) {
  const en = g.instances.filter(i => i.enabled)
  return en.some(i => isInstanceSelected(i)) && !isGroupAllSelected(g)
}
function toggleGroup(g: InstanceGroup) {
  const set = new Set(cleanup.selectedInstanceIds.value)
  const en = g.instances.filter(i => i.enabled)
  if (isGroupAllSelected(g)) { for (const i of en) set.delete(i.id) } else { for (const i of en) set.add(i.id) }
  cleanup.selectedInstanceIds.value = set
}

// 全选
const allEnabledInstances = computed(() => (groups.value ?? []).flatMap(g => g.instances.filter(i => i.enabled)))
const isAllSelected = computed(() => allEnabledInstances.value.length > 0 && allEnabledInstances.value.every(i => isInstanceSelected(i)))
const isAllPartialSelected = computed(() => allEnabledInstances.value.some(i => isInstanceSelected(i)) && !isAllSelected.value)
function toggleSelectAllInstances() {
  const set = new Set(cleanup.selectedInstanceIds.value)
  if (isAllSelected.value) {
    for (const i of allEnabledInstances.value) set.delete(i.id)
  } else {
    for (const i of allEnabledInstances.value) set.add(i.id)
  }
  cleanup.selectedInstanceIds.value = set
}

const selectedInstances = computed(() => cleanup.getSelectedInstances(groups.value ?? []))

// 选中实例变化时加载 bucket
watch(() => cleanup.selectedInstanceIds.value, () => {
  cleanup.loadBuckets(groups.value ?? [])
}, { deep: true })

// ---------- 2. Bucket 交集 ----------
const bucketIntersection = computed(() => cleanup.getBucketIntersection(groups.value ?? []))
const bucketLoadError = computed(() => cleanup.hasBucketLoadError(groups.value ?? []))
const bucketManualInput = ref<string>('')

// 选中实例变化时重置 bucket 选择
watch(() => cleanup.selectedInstanceIds.value, () => {
  cleanup.selectedBucket.value = ''
  bucketManualInput.value = ''
}, { deep: true })

// ---------- 3. 前缀过滤 ----------
const prefixInput = ref<string>('')

/** 输入时实时同步到 cleanup.prefix（带清洗） */
function onPrefixInput(val: string) {
  prefixInput.value = val
  cleanup.prefix.value = sanitizePrefix(val)
}

/** 回车/失焦时把输入框显示值也归一化 */
function normalizePrefixInput() {
  prefixInput.value = cleanup.prefix.value
}

// ---------- 4. 预览（自动加载） ----------

/** 预览参考实例下拉选项 */
const previewReferenceOptions = computed(() =>
  selectedInstances.value.map(i => ({ label: `${i.name} (${i.endpoint})`, value: i.id })),
)

/** 自动加载预览：bucket 或前缀变化时触发（防抖 300ms） */
let previewTimer: ReturnType<typeof setTimeout> | undefined
watch([() => cleanup.selectedBucket.value, () => cleanup.prefix.value], () => {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    // 有 bucket + 有选中实例才预览
    if (cleanup.selectedBucket.value && selectedInstances.value.length) {
      const refId = cleanup.previewReferenceInstanceId.value || selectedInstances.value[0]!.id
      cleanup.loadPreview(refId)
    }
    else {
      // 清空预览状态
      cleanup.previewObjects.value = []
      cleanup.previewPrefixes.value = []
      cleanup.previewContinuationToken.value = undefined
      cleanup.selectedKeys.value = new Set()
      cleanup.selectedPrefixes.value = new Set()
    }
  }, 300)
}, { immediate: true })

/** 切换参考实例时重新预览 */
watch(() => cleanup.previewReferenceInstanceId.value, (newId) => {
  if (newId && cleanup.selectedBucket.value) {
    cleanup.loadPreview(newId)
  }
})

/** 清理完成后自动刷新预览（isRunning 从 true -> false） */
watch(() => cleanup.isRunning.value, (running, prev) => {
  if (prev && !running && cleanup.selectedBucket.value && selectedInstances.value.length) {
    // 清空之前的勾选状态
    cleanup.selectedKeys.value = new Set()
    cleanup.selectedPrefixes.value = new Set()
    const refId = cleanup.previewReferenceInstanceId.value || selectedInstances.value[0]!.id
    cleanup.loadPreview(refId)
  }
})

/** 加载更多预览 */
async function loadMorePreview() {
  const token = cleanup.previewContinuationToken.value
  if (!token) return
  const refId = cleanup.previewReferenceInstanceId.value || selectedInstances.value[0]?.id
  if (refId) await cleanup.loadPreview(refId, token)
}

// ---------- 5. 执行确认 ----------
/** 高危检测：无前缀 + 无精确勾选 = 清空 bucket */
const isHighRisk = computed(() =>
  !cleanup.prefix.value && !cleanup.selectedKeys.value.size && !cleanup.selectedPrefixes.value.size,
)

/** 构建确认弹窗描述 */
function buildConfirmDescription(): string {
  const instList = selectedInstances.value
    .map(i => `  • ${i.name} (${i.endpoint})`)
    .join('\n')

  const bucket = cleanup.selectedBucket.value
  const pfx = cleanup.prefix.value
  const hasKeys = cleanup.selectedKeys.value.size > 0
  const hasPrefixes = cleanup.selectedPrefixes.value.size > 0

  let scope: string
  if (hasKeys || hasPrefixes) {
    const parts: string[] = []
    if (hasPrefixes) {
      const pfxList = Array.from(cleanup.selectedPrefixes.value)
        .map(p => `  • 📁 ${p}`).join('\n')
      parts.push(`文件夹（递归删除）:\n${pfxList}`)
    }
    if (hasKeys) {
      const selectedObjs = cleanup.previewObjects.value.filter(o => cleanup.selectedKeys.value.has(o.key))
      const totalSize = selectedObjs.reduce((s, o) => s + o.size, 0)
      const objList = selectedObjs
        .map(o => `  • ${displayName(o.key)} (${formatSize(o.size)})`)
        .join('\n')
      const objDisplay = objList.length > 500 ? `${objList.slice(0, 500)}\n  …等 ${cleanup.selectedKeys.value.size} 个对象` : objList
      parts.push(`对象（共 ${cleanup.selectedKeys.value.size} 个，${formatSize(totalSize)}）:\n${objDisplay}`)
    }
    scope = parts.join('\n\n')
  } else if (pfx) {
    scope = `前缀: ${pfx}${cleanup.recursive.value ? '（递归删除所有子对象）' : '（仅删除当前层直接对象）'}`
  } else {
    scope = '⚠️ 清空整个 bucket 中的所有对象'
  }

  return `即将在 ${selectedInstances.value.length} 个实例上清理对象\n\n清理范围:\n  • Bucket: ${bucket}\n${hasKeys || hasPrefixes ? '' : `  • ${scope}\n`}\n${hasKeys || hasPrefixes ? scope + '\n' : ''}目标实例:\n${instList}\n\n此操作不可恢复。`
}

/** 高危确认：输入 bucket 名 */
const highRiskConfirmInput = ref<string>('')
const highRiskModalOpen = ref(false)

async function startCleanup() {
  if (isHighRisk.value) {
    // 高危场景：先弹出自定义高危确认
    highRiskConfirmInput.value = ''
    highRiskModalOpen.value = true
    return
  }
  // 普通场景：直接弹 ConfirmDialog
  await doConfirm()
}

async function doConfirm() {
  const toast = useToast()
  const overlay = useOverlay()
  const modal = overlay.create(ConfirmDialog, { destroyOnClose: true })

  const confirm = await modal.open({
    title: '确认清理',
    description: buildConfirmDescription(),
    confirmText: '确认清理',
    confirmColor: 'error',
    confirmIcon: 'i-lucide-trash-2',
  })
  if (!confirm) return

  await cleanup.submit(groups.value ?? [])
}

function closeHighRiskModal() {
  highRiskModalOpen.value = false
}

/** 高危确认弹窗的确认按钮 */
async function confirmHighRisk() {
  if (highRiskConfirmInput.value !== cleanup.selectedBucket.value) {
    const toast = useToast()
    toast.add({ title: 'bucket 名称不匹配', description: '请输入正确的 bucket 名称以确认', color: 'error' })
    return
  }
  highRiskModalOpen.value = false
  await doConfirm()
}

// ---------- 6. 进度视图 ----------
const progressExpanded = ref<Record<string, boolean>>({})
function toggleProgressExpand(id: string) { progressExpanded.value[id] = !progressExpanded.value[id] }
const showProgress = computed(() => cleanup.isRunning.value || Object.keys(cleanup.progress.value).length > 0)

/** 计算进度展示用的 targets 列表 */
const progressTargets = computed(() => {
  const targets: string[] = []
  if (cleanup.selectedKeys.value.size) targets.push(...Array.from(cleanup.selectedKeys.value))
  if (cleanup.selectedPrefixes.value.size) targets.push(...Array.from(cleanup.selectedPrefixes.value))
  if (!targets.length) targets.push(cleanup.prefix.value || '/')
  return targets
})

/** 总进度 */
const totalProgress = computed(() => {
  if (!progressTargets.value.length) return { completed: 0, total: 0, failed: 0 }
  let completed = 0
  let failed = 0
  const total = progressTargets.value.length * selectedInstances.value.length
  for (const inst of selectedInstances.value) {
    const p = cleanup.getInstanceProgress(inst.id, progressTargets.value)
    completed += p.completed
    failed += p.failed
  }
  return { completed, total, failed }
})

// 页面标题
useHead({ title: '批量清理 · miniops' })
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 页头 -->
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-bold text-highlighted">批量清理</h1>
      <p class="text-muted">跨实例批量删除 MinIO 对象，支持按前缀递归清理</p>
    </div>

    <!-- 1. 选择目标实例 -->
    <div class="rounded-lg border border-default bg-default p-4">
      <div class="mb-3 flex items-center gap-3">
        <h2 class="font-semibold text-highlighted">1. 选择目标实例</h2>
        <div class="flex-1" />
        <NuxtCheckbox
          :model-value="isAllSelected"
          :indeterminate="isAllPartialSelected"
          label="全选"
          @update:model-value="toggleSelectAllInstances"
        />
      </div>
      <template v-for="g in groups" :key="g.id">
        <div class="rounded-md border border-default">
          <div class="flex items-center gap-3 p-3">
            <NuxtCheckbox
              :model-value="isGroupAllSelected(g)"
              :indeterminate="isGroupPartialSelected(g)"
              :disabled="!g.instances.filter(i => i.enabled).length"
              @update:model-value="toggleGroup(g)"
            />
            <button class="flex items-center gap-2 flex-1 text-left" @click="expanded[g.id] = !expanded[g.id]">
              <NuxtIcon :name="expanded[g.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-muted" />
              <NuxtIcon name="i-lucide-folder" class="size-4 text-primary" />
              <span class="font-semibold text-highlighted">{{ g.name }}</span>
              <NuxtBadge color="neutral" variant="subtle" size="sm">{{ g.instances.filter(i => i.enabled).length }} 个启用</NuxtBadge>
            </button>
          </div>
          <div v-if="expanded[g.id]" class="border-t border-default">
            <div
              v-for="inst in g.instances"
              :key="inst.id"
              class="flex items-center gap-3 px-6 py-2 hover:bg-elevated"
              :class="{ 'opacity-50': !inst.enabled }"
            >
              <NuxtCheckbox
                :model-value="isInstanceSelected(inst)"
                :disabled="!inst.enabled"
                @update:model-value="toggleInstance(inst)"
              />
              <NuxtIcon name="i-lucide-server" class="size-4 text-muted" />
              <span class="text-sm font-medium">{{ inst.name }}</span>
              <span class="font-mono text-xs text-muted">{{ inst.endpoint }}</span>
              <NuxtBadge v-if="!inst.enabled" color="neutral" variant="outline" size="sm">禁用</NuxtBadge>
            </div>
            <div v-if="!g.instances.length" class="px-6 py-3 text-sm text-muted">该组无实例</div>
          </div>
        </div>
      </template>
      <div v-if="selectedInstances.length" class="mt-2 text-sm text-muted">
        已选 <span class="font-semibold text-highlighted">{{ selectedInstances.length }}</span> 个实例
      </div>
    </div>

    <!-- 2. 选择 Bucket -->
    <div
      class="rounded-lg border border-default bg-default p-4 transition-opacity"
      :class="{ 'opacity-50 pointer-events-none': !selectedInstances.length }"
    >
      <h2 class="mb-3 font-semibold text-highlighted">2. 选择 Bucket</h2>
      <div class="flex items-center gap-2">
        <NuxtSelectMenu
          v-if="!bucketLoadError"
          v-model="cleanup.selectedBucket.value"
          :items="bucketIntersection.map(b => ({ label: b, value: b }))"
          value-key="value"
          :placeholder="bucketIntersection.length ? '选择 bucket（选中实例的公共 bucket）' : '无公共 bucket'"
          class="w-full max-w-md"
          :disabled="cleanup.isRunning.value"
        >
          <template #label>
            <span v-if="cleanup.selectedBucket.value" class="font-mono truncate">{{ cleanup.selectedBucket.value }}</span>
            <span v-else class="text-muted">{{ bucketIntersection.length ? '选择 bucket' : '无公共 bucket' }}</span>
          </template>
        </NuxtSelectMenu>
        <!-- 加载失败兜底：手动输入 -->
        <template v-if="bucketLoadError">
          <NuxtTooltip :text="cleanup.getInstanceBucketOptions(selectedInstances[0]!)?.error || '部分实例 bucket 加载失败'">
            <NuxtIcon name="i-lucide-triangle-alert" class="size-4 text-warning shrink-0" />
          </NuxtTooltip>
          <NuxtInput
            v-model="bucketManualInput"
            placeholder="手动输入 bucket 名"
            class="w-full max-w-md"
            :disabled="cleanup.isRunning.value"
            @update:model-value="(val: string) => cleanup.selectedBucket.value = val"
          />
        </template>
        <span v-if="!selectedInstances.length" class="text-sm text-muted">请先选择实例</span>
        <span v-else-if="!bucketIntersection.length && !bucketLoadError" class="text-sm text-muted">
          选中实例没有公共 bucket
        </span>
      </div>
      <p class="mt-2 text-xs text-muted">所有选中实例必须指定同一个 bucket 才能跨实例清理</p>
    </div>

    <!-- 3. 前缀过滤 -->
    <div
      class="rounded-lg border border-default bg-default p-4 transition-opacity"
      :class="{ 'opacity-50 pointer-events-none': !cleanup.selectedBucket.value }"
    >
      <h2 class="mb-3 font-semibold text-highlighted">3. 前缀过滤</h2>
      <div class="flex items-center gap-2">
        <NuxtInput
          :model-value="prefixInput"
          placeholder="如 config/2025Q3/，留空则匹配 bucket 根下所有对象"
          class="flex-1"
          :disabled="cleanup.isRunning.value"
          @update:model-value="onPrefixInput"
          @blur="normalizePrefixInput"
          @keydown.enter="normalizePrefixInput"
        />
      </div>
      <div class="mt-3 flex items-center gap-3">
        <NuxtCheckbox
          v-model="cleanup.recursive.value"
          label="递归删除子前缀"
          :disabled="cleanup.isRunning.value"
        />
        <span class="text-xs text-muted">
          {{ cleanup.recursive.value ? '删除前缀下所有对象（含子目录）' : '仅删除当前前缀层的直接对象' }}
        </span>
      </div>
      <p class="mt-2 text-xs text-muted">
        当前前缀: <span class="font-mono">{{ cleanup.prefix.value || '(空 = bucket 根)' }}</span>
      </p>
    </div>

    <!-- 4. 预览匹配对象 -->
    <div
      v-if="cleanup.selectedBucket.value"
      class="rounded-lg border border-default bg-default p-4"
    >
      <div class="mb-3 flex items-center justify-between gap-2">
        <h2 class="font-semibold text-highlighted">4. 预览匹配对象</h2>
        <div class="flex items-center gap-2">
          <NuxtSelectMenu
            v-model="cleanup.previewReferenceInstanceId.value"
            :items="previewReferenceOptions"
            value-key="value"
            placeholder="参考实例"
            class="w-56"
            :disabled="cleanup.isRunning.value"
          >
            <template #label>
              <span class="truncate">{{ previewReferenceOptions.find(o => o.value === cleanup.previewReferenceInstanceId.value)?.label || '选择参考实例' }}</span>
            </template>
          </NuxtSelectMenu>
          <NuxtButton
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-refresh-cw"
            :loading="cleanup.previewLoading.value && !cleanup.previewContinuationToken.value"
            :disabled="cleanup.isRunning.value"
            @click="cleanup.loadPreview(cleanup.previewReferenceInstanceId.value || selectedInstances[0]?.id || '')"
          />
        </div>
      </div>

      <!-- 预览说明 -->
      <div class="mb-3 rounded-md bg-elevated p-3 text-xs text-muted">
        <p>· 预览基于参考实例的对象列表，其他实例按相同 key 删除</p>
        <p>· 各实例实际对象可能略有差异，删除时对不存在的 key 自动跳过</p>
        <p>· 勾选「递归」时文件夹下所有对象都会被删除</p>
      </div>

      <!-- 预览加载中 -->
      <div v-if="cleanup.previewLoading.value && !cleanup.previewObjects.value.length && !cleanup.previewPrefixes.value.length" class="flex items-center gap-2 py-8 justify-center text-muted">
        <NuxtIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
        <span>加载中…</span>
      </div>

      <!-- 预览加载失败 -->
      <div v-else-if="cleanup.previewError.value" class="flex flex-col items-center gap-2 py-8">
        <NuxtIcon name="i-lucide-cloud-off" class="size-8 text-error" />
        <span class="text-error">{{ cleanup.previewError.value }}</span>
        <NuxtButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" label="重试" @click="cleanup.loadPreview(cleanup.previewReferenceInstanceId.value || selectedInstances[0]?.id || '')" />
      </div>

      <!-- 预览空状态 -->
      <div v-else-if="!cleanup.previewObjects.value.length && !cleanup.previewPrefixes.value.length" class="flex flex-col items-center gap-2 py-8 text-muted">
        <NuxtIcon name="i-lucide-folder-open" class="size-10" />
        <span>该前缀下暂无对象</span>
      </div>

      <!-- 预览对象列表 -->
      <template v-else>
        <!-- 工具栏：全选 + 计数 -->
        <div class="mb-2 flex items-center gap-3">
          <NuxtCheckbox
            :model-value="cleanup.isAllSelected.value"
            :indeterminate="cleanup.isPartialSelected.value"
            @update:model-value="cleanup.toggleSelectAll()"
          />
          <span class="text-sm text-muted">
            已选 {{ cleanup.selectedCount.value }}/{{ cleanup.allSelectable.value.length }} 项
          </span>
        </div>

        <div class="flex flex-col gap-0.5 select-none">
          <!-- 虚拟文件夹 -->
          <div
            v-for="cp in cleanup.previewPrefixes.value"
            :key="`cp-${cp}`"
            class="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-elevated"
          >
            <NuxtCheckbox
              :model-value="cleanup.selectedPrefixes.value.has(cp)"
              @update:model-value="cleanup.toggleSelectPrefix(cp)"
            />
            <NuxtIcon name="i-lucide-folder" class="size-4 shrink-0 text-primary" />
            <span class="font-mono truncate flex-1">{{ cp.replace(cleanup.prefix.value, '') }}</span>
            <span class="text-muted text-xs shrink-0">（递归）</span>
          </div>

          <!-- 对象 -->
          <div
            v-for="obj in cleanup.previewObjects.value"
            :key="`obj-${obj.key}`"
            class="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-elevated"
          >
            <NuxtCheckbox
              :model-value="cleanup.selectedKeys.value.has(obj.key)"
              @update:model-value="cleanup.toggleSelectKey(obj.key)"
            />
            <NuxtIcon :name="fileIcon(obj.key)" class="size-4 shrink-0 text-muted" />
            <NuxtTooltip :text="obj.key">
              <span class="font-mono truncate flex-1">{{ displayName(obj.key) }}</span>
            </NuxtTooltip>
            <span class="text-muted text-xs shrink-0 w-20 text-right">{{ formatSize(obj.size) }}</span>
            <span class="text-muted text-xs shrink-0 w-36 text-right">{{ formatDate(obj.lastModified) }}</span>
          </div>

          <!-- 加载更多 -->
          <div v-if="cleanup.previewContinuationToken.value" class="flex justify-center pt-3">
            <NuxtButton
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-chevron-down"
              label="加载更多"
              :loading="cleanup.previewLoading.value && !!cleanup.previewContinuationToken.value"
              @click="loadMorePreview"
            />
          </div>
        </div>
      </template>
    </div>

    <!-- 5. 执行栏 -->
    <div class="flex items-center gap-4">
      <div class="flex-1" />
      <div class="text-sm text-muted">
        已选 <span class="font-semibold text-highlighted">{{ selectedInstances.length }}</span> 个实例
        <template v-if="cleanup.selectedCount.value > 0">
          ，{{ cleanup.selectedCount.value }} 个对象/前缀
        </template>
      </div>
      <NuxtButton
        v-if="!cleanup.isRunning.value"
        color="error"
        size="lg"
        icon="i-lucide-trash-2"
        label="开始清理"
        :disabled="!selectedInstances.length || !cleanup.selectedBucket.value"
        @click="startCleanup"
      />
      <NuxtButton
        v-else
        color="error"
        variant="outline"
        size="lg"
        icon="i-lucide-x"
        label="取消"
        @click="cleanup.cancel()"
      />
    </div>

    <!-- 6. 清理进度 -->
    <div v-if="showProgress" class="rounded-lg border border-default bg-default p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-semibold text-highlighted">清理进度</h2>
        <div v-if="cleanup.taskSummary.value" class="flex items-center gap-3 text-sm">
          <span class="text-muted">共 {{ cleanup.taskSummary.value.total }}</span>
          <NuxtBadge color="success" variant="soft" size="sm">成功 {{ cleanup.taskSummary.value.success }}</NuxtBadge>
          <NuxtBadge color="error" variant="soft" size="sm">失败 {{ cleanup.taskSummary.value.failed }}</NuxtBadge>
        </div>
        <NuxtIcon v-else-if="cleanup.isRunning.value" name="i-lucide-loader-circle" class="size-5 animate-spin text-primary" />
      </div>

      <!-- 总进度条 -->
      <div v-if="cleanup.isRunning.value && totalProgress.total" class="mb-4">
        <div class="flex items-center justify-between mb-1 text-sm text-muted">
          <span>正在清理... {{ totalProgress.completed }}/{{ totalProgress.total }}</span>
          <span v-if="totalProgress.failed" class="text-error">失败 {{ totalProgress.failed }}</span>
        </div>
        <NuxtProgress
          :model-value="totalProgress.total ? (totalProgress.completed / totalProgress.total * 100) : 0"
          size="sm"
        />
      </div>

      <!-- 实例级折叠列表 -->
      <div class="flex flex-col gap-2">
        <div v-for="inst in selectedInstances" :key="inst.id" class="rounded-md border border-default">
          <div class="flex items-center gap-3 p-3 cursor-pointer hover:bg-elevated" @click="toggleProgressExpand(inst.id)">
            <NuxtIcon :name="progressExpanded[inst.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-muted shrink-0" />
            <NuxtIcon name="i-lucide-server" class="size-4 text-muted shrink-0" />
            <span class="font-medium text-sm">{{ inst.name }}</span>
            <span class="font-mono text-xs text-muted">{{ inst.endpoint }}</span>
            <div class="flex-1" />
            <span class="text-sm text-muted">
              {{ cleanup.getInstanceProgress(inst.id, progressTargets).completed }}/{{ cleanup.getInstanceProgress(inst.id, progressTargets).total }}
            </span>
            <NuxtBadge
              v-if="cleanup.getInstanceProgress(inst.id, progressTargets).failed > 0"
              color="error"
              variant="soft"
              size="sm"
            >
              失败 {{ cleanup.getInstanceProgress(inst.id, progressTargets).failed }}
            </NuxtBadge>
            <div class="w-24">
              <NuxtProgress
                :model-value="cleanup.getInstanceProgress(inst.id, progressTargets).total
                  ? (cleanup.getInstanceProgress(inst.id, progressTargets).completed / cleanup.getInstanceProgress(inst.id, progressTargets).total * 100)
                  : 0"
                size="sm"
              />
            </div>
          </div>
          <div v-if="progressExpanded[inst.id]" class="border-t border-default px-6 py-2">
            <div v-for="t in progressTargets" :key="t" class="flex items-center gap-2 py-1 text-sm">
              <NuxtIcon :name="t.endsWith('/') ? 'i-lucide-folder' : fileIcon(t)" class="size-3.5 shrink-0 text-muted" />
              <span class="font-mono truncate flex-1 text-xs">{{ t }}</span>
              <template v-if="cleanup.getCell(inst.id, t) === 'running'">
                <NuxtIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin text-primary shrink-0" />
              </template>
              <template v-else-if="cleanup.getCell(inst.id, t) === null">
                <span class="text-muted text-xs">等待中</span>
              </template>
              <template v-else>
                <NuxtTooltip v-if="(cleanup.getCell(inst.id, t) as CleanupResult)?.status === 'success'">
                  <NuxtIcon name="i-lucide-check-circle" class="size-3.5 text-success shrink-0" />
                  <template #content>
                    已删除
                    <template v-if="(cleanup.getCell(inst.id, t) as CleanupResult)?.deletedCount">
                      （{{ (cleanup.getCell(inst.id, t) as CleanupResult)?.deletedCount }} 个对象）
                    </template>
                    · {{ (cleanup.getCell(inst.id, t) as CleanupResult)?.duration }}ms
                  </template>
                </NuxtTooltip>
                <NuxtTooltip v-else>
                  <NuxtIcon name="i-lucide-x-circle" class="size-3.5 text-error shrink-0" />
                  <template #content>失败 · {{ (cleanup.getCell(inst.id, t) as CleanupResult)?.error }}</template>
                </NuxtTooltip>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 完成后操作 -->
      <div v-if="cleanup.taskSummary.value && !cleanup.isRunning.value" class="mt-4 flex justify-end">
        <NuxtButton
          color="neutral"
          variant="outline"
          icon="i-lucide-rotate-ccw"
          label="重新清理"
          @click="cleanup.progress.value = {}; cleanup.taskSummary.value = null"
        />
      </div>
    </div>

    <!-- 高危确认弹窗 -->
    <NuxtModal
      v-model:open="highRiskModalOpen"
      title="⚠️ 高危操作"
      :dismissible="false"
      :ui="{ footer: 'justify-end' }"
    >
      <template #body>
        <div class="flex flex-col gap-3 py-2">
          <div class="flex items-start gap-2">
            <NuxtIcon name="i-lucide-triangle-alert" class="size-6 text-error shrink-0 mt-0.5" />
            <div class="text-sm">
              <p class="font-semibold text-error">你即将清空 {{ selectedInstances.length }} 个实例上的 {{ cleanup.selectedBucket.value }} bucket 中的全部对象！</p>
              <p class="mt-2 text-muted">这将删除所有对象，且不可恢复。</p>
            </div>
          </div>
          <div>
            <p class="text-sm mb-2">请输入 bucket 名称 <span class="font-mono font-semibold text-highlighted">{{ cleanup.selectedBucket.value }}</span> 以确认：</p>
            <NuxtInput
              v-model="highRiskConfirmInput"
              :placeholder="cleanup.selectedBucket.value"
              class="w-full"
              @keydown.enter="confirmHighRisk"
            />
          </div>
        </div>
      </template>
      <template #footer>
        <NuxtButton
          color="neutral"
          variant="outline"
          label="取消"
          @click="closeHighRiskModal"
        />
        <NuxtButton
          color="error"
          icon="i-lucide-trash-2"
          label="确认清空"
          :disabled="highRiskConfirmInput !== cleanup.selectedBucket.value"
          @click="confirmHighRisk"
        />
      </template>
    </NuxtModal>
  </div>
</template>
