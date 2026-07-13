<script setup lang="ts">
interface MinioInstance { id: string; groupId: string; name: string; endpoint: string; accessKey: string; secretKey: string; enabled: boolean }
interface InstanceGroup { id: string; name: string; description?: string; instances: MinioInstance[]; isDefault?: boolean; createdAt: string; updatedAt: string }
interface SyncSource { instanceId: string; bucket: string; prefix: string; keys: string[]; prefixes: string[] }

const props = defineProps<{
  open: boolean
  sourceInstanceId: string
  sourceInstanceName: string
  sourceEndpoint: string
  sourceBucket: string
  sourcePrefix: string
  selectedKeys: Set<string>
  selectedPrefixes: Set<string>
  sync: ReturnType<typeof useSync>
}>()

const emit = defineEmits<{
  'update:open': [boolean]
  complete: []
}>()

const { data: groups } = await useFetch<InstanceGroup[]>('/api/groups', { default: () => [] })
const toast = useToast()

const sync = props.sync
const expanded = ref<Record<string, boolean>>({})
const progressExpanded = ref<Record<string, boolean>>({})

// 实例行默认展开（提交后立即显示文件列表）
watch(() => sync.modalPhase.value, (phase) => {
  if (phase === 'progress' || phase === 'done') {
    nextTick(() => {
      for (const inst of sync.getSelectedInstances(groups.value ?? [])) {
        progressExpanded.value[inst.id] = true
      }
    })
  }
})

// 源选中数
const sourceSelectedCount = computed(() => props.selectedKeys.size + props.selectedPrefixes.size)

// 目标实例树
function isInstanceSelected(inst: MinioInstance) { return sync.targetInstanceIds.value.has(inst.id) }
function toggleInstance(inst: MinioInstance) {
  const set = new Set(sync.targetInstanceIds.value)
  set.has(inst.id) ? set.delete(inst.id) : set.add(inst.id)
  sync.targetInstanceIds.value = set
}
function isGroupAllSelected(g: InstanceGroup) {
  const en = g.instances.filter(i => i.enabled && i.id !== props.sourceInstanceId)
  return en.length > 0 && en.every(i => isInstanceSelected(i))
}
function isGroupPartialSelected(g: InstanceGroup) {
  const en = g.instances.filter(i => i.enabled && i.id !== props.sourceInstanceId)
  return en.some(i => isInstanceSelected(i)) && !isGroupAllSelected(g)
}
function toggleGroup(g: InstanceGroup) {
  const set = new Set(sync.targetInstanceIds.value)
  const en = g.instances.filter(i => i.enabled && i.id !== props.sourceInstanceId)
  if (isGroupAllSelected(g)) { for (const i of en) set.delete(i.id) } else { for (const i of en) set.add(i.id) }
  sync.targetInstanceIds.value = set
}
function isSourceInstance(inst: MinioInstance): boolean {
  return inst.id === props.sourceInstanceId
}

watch(() => sync.targetInstanceIds.value, () => { sync.loadTargetBuckets(groups.value ?? []) }, { deep: true })

const groupBucketInput = ref<Record<string, string>>({})
function applyGroupBucket(g: InstanceGroup) {
  const val = groupBucketInput.value[g.id]
  if (!val) return
  sync.setGroupBucket(groups.value ?? [], g.id, val)
}
function getGroupBucketOptions(g: InstanceGroup) { return sync.getGroupBucketIntersection(groups.value ?? [], g.id) }

const selectedInstances = computed(() => sync.getSelectedInstances(groups.value ?? []))
const canSubmit = computed(() => {
  return sourceSelectedCount.value > 0
    && selectedInstances.value.length > 0
    && selectedInstances.value.every(i => sync.getInstanceBucket(i))
})

async function onSubmit() {
  const source: SyncSource = {
    instanceId: props.sourceInstanceId,
    bucket: props.sourceBucket,
    prefix: props.sourcePrefix,
    keys: [...props.selectedKeys],
    prefixes: [...props.selectedPrefixes],
  }
  await sync.submit(source, groups.value ?? [])
}

function onBackground() {
  emit('update:open', false)
}

function onClose() {
  sync.reset()
  emit('update:open', false)
  emit('complete')
}

function toggleProgressExpand(id: string) { progressExpanded.value[id] = !progressExpanded.value[id] }

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(1) + ' MB'
}
function fileIcon(ct: string): string {
  if (ct.startsWith('image/')) return 'i-lucide-file-image'
  if (ct.includes('json')) return 'i-lucide-file-json'
  if (ct.includes('zip') || ct.includes('gzip') || ct.includes('tar')) return 'i-lucide-file-archive'
  if (ct.startsWith('text/') || ct.includes('csv') || ct.includes('xml')) return 'i-lucide-file-text'
  if (ct.startsWith('video/')) return 'i-lucide-file-video'
  return 'i-lucide-file'
}

// Modal 打开时：如果处于 select 阶段（非进行中），清理上次的目标选择
watch(() => props.open, (val) => {
  if (val && sync.modalPhase.value === 'select') {
    sync.targetInstanceIds.value = new Set()
    sync.targetBuckets.value = {}
    sync.targetBucketOptions.value = {}
    sync.targetPrefix.value = ''
  }
})
</script>

<template>
  <NuxtModal :open="open" @update:open="emit('update:open', $event)" :ui="{ content: 'sm:max-w-2xl' }">
    <template #header>
      <span class="font-semibold text-highlighted">同步到其他实例</span>
    </template>

    <template #body>
      <!-- 阶段一：目标选择 -->
      <div v-if="sync.modalPhase.value === 'select'" class="flex flex-col gap-4">
        <!-- 源上下文（只读） -->
        <div class="rounded-lg bg-elevated p-3">
          <div class="text-xs text-muted mb-1">源（只读）</div>
          <div class="flex items-center gap-2 text-sm">
            <NuxtIcon name="i-lucide-server" class="size-4 text-muted" />
            <span class="font-medium">{{ sourceInstanceName }}</span>
            <span class="font-mono text-xs text-muted">{{ sourceEndpoint }}</span>
          </div>
          <div class="flex items-center gap-2 text-sm mt-1">
            <NuxtIcon name="i-lucide-database" class="size-4 text-muted" />
            <span class="font-mono">{{ sourceBucket }}</span>
            <span v-if="sourcePrefix" class="font-mono text-xs text-muted">/ {{ sourcePrefix }}</span>
          </div>
          <div class="text-xs text-muted mt-1">
            选中：{{ selectedKeys.size }} 个对象 + {{ selectedPrefixes.size }} 个文件夹
          </div>
        </div>

        <!-- 目标实例选择 -->
        <div>
          <div class="text-sm font-semibold text-highlighted mb-2">目标实例</div>
          <template v-for="g in groups" :key="g.id">
            <div class="rounded-md border border-default mb-2">
              <div class="flex items-center gap-3 p-2.5">
                <NuxtCheckbox :model-value="isGroupAllSelected(g)" :indeterminate="isGroupPartialSelected(g)" :disabled="!g.instances.filter(i => i.enabled && !isSourceInstance(i)).length" @update:model-value="toggleGroup(g)" />
                <button class="flex items-center gap-2 flex-1 text-left" @click="expanded[g.id] = !expanded[g.id]">
                  <NuxtIcon :name="expanded[g.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-muted" />
                  <NuxtIcon name="i-lucide-folder" class="size-4 text-primary" />
                  <span class="font-semibold text-sm text-highlighted">{{ g.name }}</span>
                </button>
                <div v-if="isGroupPartialSelected(g) || isGroupAllSelected(g)" class="flex items-center gap-1">
                  <NuxtSelectMenu :items="getGroupBucketOptions(g).map(b => ({ label: b, value: b }))" value-key="value" :placeholder="getGroupBucketOptions(g).length ? '批量设 bucket' : '无公共 bucket'" class="w-36" :disabled="!getGroupBucketOptions(g).length" @update:model-value="(val: string) => { groupBucketInput[g.id] = val; applyGroupBucket(g) }" />
                </div>
              </div>
              <div v-if="expanded[g.id]" class="border-t border-default">
                <div v-for="inst in g.instances" :key="inst.id" class="flex items-center gap-3 px-5 py-1.5 hover:bg-elevated" :class="{ 'opacity-50': !inst.enabled || isSourceInstance(inst) }">
                  <NuxtCheckbox :model-value="isInstanceSelected(inst)" :disabled="!inst.enabled || isSourceInstance(inst)" @update:model-value="toggleInstance(inst)" />
                  <NuxtIcon name="i-lucide-server" class="size-4 text-muted" />
                  <span class="text-sm">{{ inst.name }}</span>
                  <NuxtBadge v-if="isSourceInstance(inst)" color="warning" variant="soft" size="sm">源</NuxtBadge>
                  <NuxtBadge v-else-if="!inst.enabled" color="neutral" variant="outline" size="sm">禁用</NuxtBadge>
                  <div class="flex-1" />
                  <div v-if="isInstanceSelected(inst) && inst.enabled && !isSourceInstance(inst)" class="flex items-center gap-1">
                    <NuxtTooltip v-if="sync.getInstanceBucketOptions(inst).error" :text="sync.getInstanceBucketOptions(inst).error">
                      <NuxtIcon name="i-lucide-triangle-alert" class="size-4 text-warning" />
                    </NuxtTooltip>
                    <NuxtIcon v-if="sync.getInstanceBucketOptions(inst).loading" name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
                    <NuxtInput v-else-if="sync.getInstanceBucketOptions(inst).error" :model-value="sync.getInstanceBucket(inst)" placeholder="输入 bucket" class="w-28" @update:model-value="(val: string) => sync.setInstanceBucket(inst.id, val)" />
                    <NuxtSelectMenu v-else :model-value="sync.getInstanceBucket(inst)" :items="sync.getInstanceBucketOptions(inst).buckets.map(b => ({ label: b, value: b }))" value-key="value" placeholder="bucket" class="w-28" @update:model-value="(val: string) => sync.setInstanceBucket(inst.id, val)" />
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- 目标前缀 -->
          <div class="mt-2">
            <label class="text-xs text-muted">目标前缀（可选）</label>
            <NuxtInput v-model="sync.targetPrefix.value" placeholder="如 2025-q3/" class="w-full mt-1" />
          </div>
        </div>
      </div>

      <!-- 阶段二/三：进度 -->
      <div v-else class="flex flex-col gap-3">
        <!-- 源->目标上下文 -->
        <div class="text-xs text-muted">
          源: {{ sourceInstanceName }} / {{ sourceBucket }}<span v-if="sourcePrefix"> / {{ sourcePrefix }}</span>
          ->
          目标: {{ selectedInstances.length }} 个实例
        </div>

        <!-- 扫描中 -->
        <div v-if="sync.isScanning.value" class="flex items-center gap-2 py-8 justify-center text-muted">
          <NuxtIcon name="i-lucide-loader-circle" class="size-5 animate-spin text-primary" />
          <span>正在扫描源对象... 已发现 {{ sync.scannedCount.value }} 个</span>
        </div>

        <!-- 同步进度 -->
        <div v-else>
          <!-- 顶部汇总 -->
          <div class="mb-3 flex items-center justify-between">
            <div v-if="sync.taskSummary.value" class="flex items-center gap-3 text-sm">
              <span class="text-muted">共 {{ sync.taskSummary.value.total }}</span>
              <NuxtBadge color="success" variant="soft" size="sm">成功 {{ sync.taskSummary.value.success }}</NuxtBadge>
              <NuxtBadge color="error" variant="soft" size="sm">失败 {{ sync.taskSummary.value.failed }}</NuxtBadge>
            </div>
            <NuxtIcon v-else-if="sync.isRunning.value" name="i-lucide-loader-circle" class="size-5 animate-spin text-primary" />
          </div>

          <!-- 总进度条 -->
          <div v-if="sync.resolvedFiles.value.length" class="mb-3">
            <NuxtProgress :model-value="sync.taskSummary.value ? 100 : (sync.totalCount.value ? (sync.totalCompleted.value / sync.totalCount.value * 100) : 0)" size="sm" />
          </div>

          <!-- 实例级折叠列表 -->
          <div class="flex flex-col gap-2 max-h-96 overflow-y-auto">
            <div v-for="inst in selectedInstances" :key="inst.id" class="rounded-md border border-default">
              <div class="flex items-center gap-3 p-2.5 cursor-pointer hover:bg-elevated" @click="toggleProgressExpand(inst.id)">
                <NuxtIcon :name="progressExpanded[inst.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-muted shrink-0" />
                <NuxtIcon name="i-lucide-server" class="size-4 text-muted shrink-0" />
                <span class="font-medium text-sm">{{ inst.name }}</span>
                <div class="flex-1" />
                <span class="text-sm text-muted">{{ sync.getInstanceProgress(inst.id).completed }}/{{ sync.getInstanceProgress(inst.id).total }}</span>
                <NuxtBadge v-if="sync.getInstanceProgress(inst.id).failed > 0" color="error" variant="soft" size="sm">失败 {{ sync.getInstanceProgress(inst.id).failed }}</NuxtBadge>
                <div class="w-20"><NuxtProgress :model-value="sync.getInstanceProgress(inst.id).total ? (sync.getInstanceProgress(inst.id).completed / sync.getInstanceProgress(inst.id).total * 100) : 0" size="sm" /></div>
              </div>
              <div v-if="progressExpanded[inst.id]" class="border-t border-default px-5 py-2 max-h-48 overflow-y-auto">
                <div v-for="f in sync.resolvedFiles.value" :key="f.key" class="flex items-center gap-2 py-0.5 text-sm">
                  <NuxtIcon :name="fileIcon(f.contentType)" class="size-3.5 shrink-0 text-muted" />
                  <span class="font-mono truncate flex-1 text-xs">{{ f.relativeKey }}</span>
                  <template v-if="sync.getCell(inst.id, f.relativeKey) === 'running'">
                    <NuxtIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin text-primary shrink-0" />
                  </template>
                  <template v-else-if="sync.getCell(inst.id, f.relativeKey) === null">
                    <span class="text-muted text-xs">-</span>
                  </template>
                  <template v-else>
                    <NuxtTooltip v-if="(sync.getCell(inst.id, f.relativeKey) as any)?.status === 'success'">
                      <NuxtIcon name="i-lucide-check-circle" class="size-3.5 text-success shrink-0" />
                      <template #content>成功 · {{ (sync.getCell(inst.id, f.relativeKey) as any)?.duration }}ms</template>
                    </NuxtTooltip>
                    <NuxtTooltip v-else>
                      <NuxtIcon name="i-lucide-x-circle" class="size-3.5 text-error shrink-0" />
                      <template #content>失败 · {{ (sync.getCell(inst.id, f.relativeKey) as any)?.error }}</template>
                    </NuxtTooltip>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <!-- select 阶段 -->
        <template v-if="sync.modalPhase.value === 'select'">
          <NuxtButton color="neutral" variant="ghost" label="取消" @click="emit('update:open', false)" />
          <NuxtButton color="primary" icon="i-lucide-refresh-cw" label="开始同步" :disabled="!canSubmit" @click="onSubmit" />
        </template>
        <!-- progress 阶段 -->
        <template v-else-if="sync.modalPhase.value === 'progress'">
          <NuxtButton color="neutral" variant="ghost" label="后台继续" @click="onBackground" />
        </template>
        <!-- done 阶段 -->
        <template v-else>
          <NuxtButton color="primary" label="关闭" @click="onClose" />
        </template>
      </div>
    </template>
  </NuxtModal>
</template>
