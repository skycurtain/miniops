<script setup lang="ts">
interface MinioInstance { id: string; groupId: string; name: string; endpoint: string; accessKey: string; secretKey: string; enabled: boolean }
interface InstanceGroup { id: string; name: string; description?: string; instances: MinioInstance[]; isDefault?: boolean; createdAt: string; updatedAt: string }

const { data: groups } = await useFetch<InstanceGroup[]>('/api/groups', { default: () => [] })
const dispatch = useDispatch()

function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return
  dispatch.addFiles(input.files)
  input.value = ''
}
function onFolderSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return
  dispatch.addFolder(input.files)
  input.value = ''
}
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}
function fileIcon(ct: string): string {
  if (ct.startsWith('image/')) return 'i-lucide-file-image'
  if (ct.includes('json')) return 'i-lucide-file-json'
  if (ct.includes('zip') || ct.includes('gzip') || ct.includes('tar')) return 'i-lucide-file-archive'
  if (ct.startsWith('text/') || ct.includes('csv') || ct.includes('xml')) return 'i-lucide-file-text'
  if (ct.startsWith('video/')) return 'i-lucide-file-video'
  return 'i-lucide-file'
}
const uploadingCount = computed(() => Object.values(dispatch.uploadStates.value).filter(v => v === 'uploading').length)
const readyCount = computed(() => dispatch.files.value.filter(f => dispatch.getUploadStatus(f.id) === 'ready').length)

const expanded = ref<Record<string, boolean>>({})
function isInstanceSelected(inst: MinioInstance) { return dispatch.selectedInstanceIds.value.has(inst.id) }
function toggleInstance(inst: MinioInstance) {
  const set = new Set(dispatch.selectedInstanceIds.value)
  set.has(inst.id) ? set.delete(inst.id) : set.add(inst.id)
  dispatch.selectedInstanceIds.value = set
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
  const set = new Set(dispatch.selectedInstanceIds.value)
  const en = g.instances.filter(i => i.enabled)
  if (isGroupAllSelected(g)) { for (const i of en) set.delete(i.id) } else { for (const i of en) set.add(i.id) }
  dispatch.selectedInstanceIds.value = set
}
const selectedInstances = computed(() => dispatch.getSelectedInstances(groups.value ?? []))
watch(() => dispatch.selectedInstanceIds.value, () => { dispatch.loadBuckets(groups.value ?? []) }, { deep: true })

const groupBucketInput = ref<Record<string, string>>({})
function applyGroupBucket(g: InstanceGroup) {
  const val = groupBucketInput.value[g.id]
  if (!val) return
  dispatch.setGroupBucket(groups.value ?? [], g.id, val)
}
function getGroupBucketOptions(g: InstanceGroup) { return dispatch.getGroupBucketIntersection(groups.value ?? [], g.id) }

async function onSubmit() { await dispatch.submit(groups.value ?? []) }

const progressExpanded = ref<Record<string, boolean>>({})
function toggleProgressExpand(id: string) { progressExpanded.value[id] = !progressExpanded.value[id] }
const showProgress = computed(() => dispatch.isRunning.value || Object.keys(dispatch.progress.value).length > 0)

async function retryInstance(instanceId: string) {
  const inst = selectedInstances.value.find(i => i.id === instanceId)
  if (!inst) return
  const failedFiles = dispatch.files.value.filter(f => {
    const cell = dispatch.getCell(instanceId, f.objectKey)
    return cell && typeof cell === 'object' && cell.status === 'failed'
  })
  if (!failedFiles.length) return
  const toast = useToast()
  try {
    const res = await $fetch<{ taskId: string }>('/api/dispatch', {
      method: 'POST',
      body: { files: failedFiles.map(f => ({ id: f.id, objectKey: f.objectKey })), groupIds: [], instanceIds: [inst.id], instanceBuckets: { [inst.id]: dispatch.getInstanceBucket(inst) } },
    })
    const es = new EventSource(`/api/dispatch/events?taskId=${res.taskId}`)
    for (const f of failedFiles) dispatch.progress.value[dispatch.cellKey(instanceId, f.objectKey)] = 'running'
    es.addEventListener('progress', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      if (data.result) dispatch.progress.value[dispatch.cellKey(data.result.instanceId, data.result.fileName)] = data.result
    })
    es.addEventListener('complete', () => { es.close(); toast.add({ title: '重试完成', color: 'success' }) })
    es.onerror = () => { es.close() }
  } catch (e: any) {
    toast.add({ title: '重试失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- PAGE-HEADER -->
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-bold text-highlighted">文件分发</h1>
      <p class="text-muted">将文件/文件夹批量分发到目标 MinIO 实例</p>
    </div>

    <!-- 1. 文件选择 -->
    <div class="rounded-lg border border-default bg-default p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-semibold text-highlighted">1. 选择文件</h2>
        <div class="flex items-center gap-2">
          <span class="text-sm text-muted">
            已就绪 {{ readyCount }}/{{ dispatch.files.value.length }}
            <span v-if="uploadingCount > 0" class="text-primary">（上传中 {{ uploadingCount }}）</span>
          </span>
          <label class="cursor-pointer">
            <input type="file" multiple class="hidden" @change="onFilesSelected">
            <NuxtButton color="primary" variant="outline" icon="i-lucide-file-plus" label="添加文件" as="span" />
          </label>
          <label class="cursor-pointer">
            <input type="file" webkitdirectory directory multiple class="hidden" @change="onFolderSelected">
            <NuxtButton color="primary" variant="outline" icon="i-lucide-folder-plus" label="添加文件夹" as="span" />
          </label>
        </div>
      </div>
      <div v-if="dispatch.files.value.length || uploadingCount > 0" class="flex flex-col gap-1.5">
        <div v-for="f in dispatch.files.value" :key="f.id" class="flex items-center gap-2 rounded-md border border-default bg-elevated px-3 py-1.5 text-sm">
          <NuxtIcon :name="fileIcon(f.contentType)" class="size-4 shrink-0 text-primary" />
          <span class="font-mono truncate flex-1">{{ f.objectKey }}</span>
          <span class="text-muted text-xs shrink-0">{{ formatSize(f.size) }}</span>
          <NuxtIcon v-if="dispatch.getUploadStatus(f.id) === 'uploading'" name="i-lucide-loader-circle" class="size-4 animate-spin text-primary shrink-0" />
          <NuxtIcon v-else-if="dispatch.getUploadStatus(f.id) === 'error'" name="i-lucide-x-circle" class="size-4 text-error shrink-0" />
          <NuxtIcon v-else name="i-lucide-check-circle" class="size-4 text-success shrink-0" />
          <button v-if="!dispatch.isRunning.value" class="text-muted hover:text-error shrink-0" @click="dispatch.removeUpload(f.id)">
            <NuxtIcon name="i-lucide-x" class="size-3.5" />
          </button>
        </div>
        <div v-for="(state, key) in dispatch.uploadStates.value" v-show="state === 'uploading'" :key="key" class="flex items-center gap-2 rounded-md border border-default bg-elevated px-3 py-1.5 text-sm opacity-70">
          <NuxtIcon name="i-lucide-file" class="size-4 shrink-0 text-muted" />
          <span class="font-mono truncate flex-1">{{ key.replace(/^temp-/, '').replace(/-\d+$/, '') }}</span>
          <NuxtIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary shrink-0" />
        </div>
      </div>
      <div v-else class="flex items-center gap-2 py-4 text-muted">
        <NuxtIcon name="i-lucide-inbox" class="size-5" />
        <span>点击"添加文件"或"添加文件夹"选择要分发的文件（可多选，不限类型）</span>
      </div>
    </div>

    <!-- 2. 选择目标 + bucket -->
    <div class="rounded-lg border border-default bg-default p-4">
      <h2 class="mb-3 font-semibold text-highlighted">2. 选择目标 &amp; Bucket</h2>
      <template v-for="g in groups" :key="g.id">
        <div class="rounded-md border border-default">
          <div class="flex items-center gap-3 p-3">
            <NuxtCheckbox :model-value="isGroupAllSelected(g)" :indeterminate="isGroupPartialSelected(g)" :disabled="!g.instances.filter(i => i.enabled).length" @update:model-value="toggleGroup(g)" />
            <button class="flex items-center gap-2 flex-1 text-left" @click="expanded[g.id] = !expanded[g.id]">
              <NuxtIcon :name="expanded[g.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-muted" />
              <NuxtIcon name="i-lucide-folder" class="size-4 text-primary" />
              <span class="font-semibold text-highlighted">{{ g.name }}</span>
              <NuxtBadge color="neutral" variant="subtle" size="sm">{{ g.instances.filter(i => i.enabled).length }} 个启用</NuxtBadge>
            </button>
            <div v-if="isGroupPartialSelected(g) || isGroupAllSelected(g)" class="flex items-center gap-1">
              <NuxtSelectMenu :items="getGroupBucketOptions(g).map(b => ({ label: b, value: b }))" value-key="value" :placeholder="getGroupBucketOptions(g).length ? '批量设 bucket' : '无公共 bucket'" class="w-36" :disabled="dispatch.isRunning.value || !getGroupBucketOptions(g).length" @update:model-value="(val: string) => { groupBucketInput[g.id] = val; applyGroupBucket(g) }" />
            </div>
          </div>
          <div v-if="expanded[g.id]" class="border-t border-default">
            <div v-for="inst in g.instances" :key="inst.id" class="flex items-center gap-3 px-6 py-2 hover:bg-elevated" :class="{ 'opacity-50': !inst.enabled }">
              <NuxtCheckbox :model-value="isInstanceSelected(inst)" :disabled="!inst.enabled" @update:model-value="toggleInstance(inst)" />
              <NuxtIcon name="i-lucide-server" class="size-4 text-muted" />
              <span class="text-sm font-medium">{{ inst.name }}</span>
              <span class="font-mono text-xs text-muted">{{ inst.endpoint }}</span>
              <NuxtBadge v-if="!inst.enabled" color="neutral" variant="outline" size="sm">禁用</NuxtBadge>
              <div class="flex-1" />
              <div v-if="isInstanceSelected(inst) && inst.enabled" class="flex items-center gap-1">
                <span class="text-xs text-muted">bucket</span>
                <NuxtIcon v-if="dispatch.getInstanceBucketOptions(inst).loading" name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
                <NuxtInput v-else-if="dispatch.getInstanceBucketOptions(inst).error" :model-value="dispatch.getInstanceBucket(inst)" placeholder="输入 bucket" class="w-32" :disabled="dispatch.isRunning.value" @update:model-value="(val: string) => dispatch.setInstanceBucket(inst.id, val)" />
                <NuxtSelectMenu v-else :model-value="dispatch.getInstanceBucket(inst)" :items="dispatch.getInstanceBucketOptions(inst).buckets.map(b => ({ label: b, value: b }))" value-key="value" placeholder="选择 bucket" class="w-32" :disabled="dispatch.isRunning.value" @update:model-value="(val: string) => dispatch.setInstanceBucket(inst.id, val)" />
              </div>
            </div>
            <div v-if="!g.instances.length" class="px-6 py-3 text-sm text-muted">该组无实例</div>
          </div>
        </div>
      </template>
    </div>

    <!-- 3. 目标前缀 -->
    <div class="rounded-lg border border-default bg-default p-4">
      <h2 class="mb-3 font-semibold text-highlighted">3. 目标前缀（可选）</h2>
      <NuxtInput v-model="dispatch.prefix.value" placeholder="如 config/2025Q3/" :disabled="dispatch.isRunning.value" class="w-full" />
      <p class="mt-2 text-xs text-muted">填写后文件将分发到 <span class="font-mono">bucket/prefix/</span> 下；留空则上传到 bucket 根</p>
    </div>

    <!-- 4. 提交栏 -->
    <div class="flex items-center gap-4">
      <div class="flex-1" />
      <div class="text-sm text-muted">已选 <span class="font-semibold text-highlighted">{{ selectedInstances.length }}</span> 个实例，{{ dispatch.files.value.length }} 个文件</div>
      <NuxtButton v-if="!dispatch.isRunning.value" color="primary" size="lg" icon="i-lucide-send" label="开始分发" :disabled="!dispatch.files.value.length || !selectedInstances.length || !dispatch.allFilesReady.value" @click="onSubmit" />
      <NuxtButton v-else color="error" variant="outline" size="lg" icon="i-lucide-x" label="取消" @click="dispatch.cancel()" />
    </div>

    <!-- 5. 分发进度（聚合视图） -->
    <div v-if="showProgress" class="rounded-lg border border-default bg-default p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-semibold text-highlighted">分发进度</h2>
        <div v-if="dispatch.taskSummary.value" class="flex items-center gap-3 text-sm">
          <span class="text-muted">共 {{ dispatch.taskSummary.value.total }}</span>
          <NuxtBadge color="success" variant="soft" size="sm">成功 {{ dispatch.taskSummary.value.success }}</NuxtBadge>
          <NuxtBadge color="error" variant="soft" size="sm">失败 {{ dispatch.taskSummary.value.failed }}</NuxtBadge>
        </div>
        <NuxtIcon v-else-if="dispatch.isRunning.value" name="i-lucide-loader-circle" class="size-5 animate-spin text-primary" />
      </div>
      <div class="flex flex-col gap-2">
        <div v-for="inst in selectedInstances" :key="inst.id" class="rounded-md border border-default">
          <div class="flex items-center gap-3 p-3 cursor-pointer hover:bg-elevated" @click="toggleProgressExpand(inst.id)">
            <NuxtIcon :name="progressExpanded[inst.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 text-muted shrink-0" />
            <NuxtIcon name="i-lucide-server" class="size-4 text-muted shrink-0" />
            <span class="font-medium text-sm">{{ inst.name }}</span>
            <div class="flex-1" />
            <span class="text-sm text-muted">{{ dispatch.getInstanceProgress(inst.id).completed }}/{{ dispatch.getInstanceProgress(inst.id).total }}</span>
            <NuxtBadge v-if="dispatch.getInstanceProgress(inst.id).failed > 0" color="error" variant="soft" size="sm">失败 {{ dispatch.getInstanceProgress(inst.id).failed }}</NuxtBadge>
            <div class="w-24"><NuxtProgress :model-value="dispatch.getInstanceProgress(inst.id).total ? (dispatch.getInstanceProgress(inst.id).completed / dispatch.getInstanceProgress(inst.id).total * 100) : 0" size="sm" /></div>
            <NuxtButton v-if="dispatch.getInstanceProgress(inst.id).failed > 0 && !dispatch.isRunning.value" size="xs" color="warning" variant="ghost" icon="i-lucide-rotate-ccw" label="重试" @click.stop="retryInstance(inst.id)" />
          </div>
          <div v-if="progressExpanded[inst.id]" class="border-t border-default px-6 py-2">
            <div v-for="f in dispatch.files.value" :key="f.id" class="flex items-center gap-2 py-1 text-sm">
              <NuxtIcon :name="fileIcon(f.contentType)" class="size-3.5 shrink-0 text-muted" />
              <span class="font-mono truncate flex-1 text-xs">{{ f.objectKey }}</span>
              <template v-if="dispatch.getCell(inst.id, f.objectKey) === 'running'">
                <NuxtIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin text-primary shrink-0" />
              </template>
              <template v-else-if="dispatch.getCell(inst.id, f.objectKey) === null">
                <span class="text-muted text-xs">—</span>
              </template>
              <template v-else>
                <NuxtTooltip v-if="(dispatch.getCell(inst.id, f.objectKey) as any)?.status === 'success'">
                  <NuxtIcon name="i-lucide-check-circle" class="size-3.5 text-success shrink-0" />
                  <template #content>成功 · {{ (dispatch.getCell(inst.id, f.objectKey) as any)?.duration }}ms</template>
                </NuxtTooltip>
                <NuxtTooltip v-else>
                  <NuxtIcon name="i-lucide-x-circle" class="size-3.5 text-error shrink-0" />
                  <template #content>失败 · {{ (dispatch.getCell(inst.id, f.objectKey) as any)?.error }}</template>
                </NuxtTooltip>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
