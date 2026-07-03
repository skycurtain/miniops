<script setup lang="ts">
interface MinioInstance {
  id: string
  groupId: string
  name: string
  endpoint: string
  accessKey: string
  secretKey: string
  bucket?: string
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

// 数据
const { data: groups, refresh } = await useFetch<InstanceGroup[]>('/api/groups', {
  default: () => [],
})

// 分发逻辑
const dispatch = useDispatch()

// ---------- 文件选择 ----------
async function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const fileList = input.files
  if (!fileList) return

  const newFiles: { name: string; content: string }[] = []
  for (const file of Array.from(fileList)) {
    try {
      const content = await file.text()
      newFiles.push({ name: file.name, content })
    }
    catch {
      const toast = useToast()
      toast.add({ title: '读取失败', description: file.name, color: 'error' })
    }
  }
  // 去重（按文件名）
  const existing = new Set(dispatch.files.value.map(f => f.name))
  for (const f of newFiles) {
    if (!existing.has(f.name)) dispatch.files.value.push(f)
  }
  // 重置 input
  input.value = ''
}

function removeFile(name: string) {
  dispatch.files.value = dispatch.files.value.filter(f => f.name !== name)
}

// ---------- 目标选择（checkbox 联动）----------
const expanded = ref<Record<string, boolean>>({})

function isInstanceSelected(inst: MinioInstance): boolean {
  return dispatch.selectedInstanceIds.value.has(inst.id)
}

function toggleInstance(inst: MinioInstance) {
  const set = new Set(dispatch.selectedInstanceIds.value)
  if (set.has(inst.id)) set.delete(inst.id)
  else set.add(inst.id)
  dispatch.selectedInstanceIds.value = set
}

function isGroupAllSelected(g: InstanceGroup): boolean {
  const enabled = g.instances.filter(i => i.enabled)
  return enabled.length > 0 && enabled.every(i => isInstanceSelected(i))
}

function isGroupPartialSelected(g: InstanceGroup): boolean {
  const enabled = g.instances.filter(i => i.enabled)
  return enabled.some(i => isInstanceSelected(i)) && !isGroupAllSelected(g)
}

function toggleGroup(g: InstanceGroup) {
  const set = new Set(dispatch.selectedInstanceIds.value)
  const enabled = g.instances.filter(i => i.enabled)
  if (isGroupAllSelected(g)) {
    // 全选 → 取消全选
    for (const i of enabled) set.delete(i.id)
  }
  else {
    // 非全选 → 全选
    for (const i of enabled) set.add(i.id)
  }
  dispatch.selectedInstanceIds.value = set
}

// 选中的实例列表
const selectedInstances = computed(() => dispatch.getSelectedInstances(groups.value ?? []))

// bucket 候选项
const bucketOptions = computed(() => dispatch.getBucketOptions(groups.value ?? []))

// 自动预填 bucket
watch(bucketOptions, (opts) => {
  if (opts.length === 1 && !dispatch.bucket.value && opts[0]) {
    dispatch.bucket.value = opts[0]
  }
})

// ---------- 分发提交 ----------
async function onSubmit() {
  await dispatch.submit(groups.value ?? [])
}

// ---------- 进度矩阵 ----------
// 选中实例 × 文件 的矩阵
const matrixRows = computed(() => {
  return selectedInstances.value.map(inst => ({
    instance: inst,
    groupName: groups.value?.find(g => g.id === inst.groupId)?.name ?? inst.groupId,
    cells: dispatch.files.value.map(f => ({
      fileName: f.name,
      status: dispatch.getCell(inst.id, f.name),
    })),
  }))
})

// 矩阵是否可见（有进度数据或正在运行）
const showMatrix = computed(() => dispatch.isRunning.value || Object.keys(dispatch.progress.value).length > 0)

// ---------- 重试 ----------
// 重试 = 对失败单元格对应的实例+文件重新提交一个只含该文件的新任务
async function retryInstance(instanceId: string) {
  const inst = selectedInstances.value.find(i => i.id === instanceId)
  if (!inst) return

  // 收集该实例失败的文件
  const failedFiles = dispatch.files.value.filter(f => {
    const cell = dispatch.getCell(instanceId, f.name)
    return cell && typeof cell === 'object' && cell.status === 'failed'
  })
  if (!failedFiles.length) return

  const toast = useToast()
  try {
    const res = await $fetch<{ taskId: string }>('/api/dispatch', {
      method: 'POST',
      body: {
        files: failedFiles,
        groupIds: [inst.groupId],
        instanceIds: [inst.id],
        bucket: dispatch.bucket.value || undefined,
      },
    })

    // 监听重试的 SSE
    const es = new EventSource(`/api/dispatch/events?taskId=${res.taskId}`)
    // 标记为 running
    for (const f of failedFiles) {
      dispatch.progress.value[dispatch.cellKey(instanceId, f.name)] = 'running'
    }

    es.addEventListener('progress', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      if (data.result) {
        dispatch.progress.value[dispatch.cellKey(data.result.instanceId, data.result.fileName)] = data.result
      }
    })
    es.addEventListener('complete', () => {
      es.close()
      toast.add({ title: '重试完成', color: 'success' })
    })
    es.onerror = () => { es.close() }
  }
  catch (e: any) {
    toast.add({ title: '重试失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 页头 -->
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-bold text-highlighted">文件分发</h1>
      <p class="text-muted">将 JSON 配置文件批量分发到目标 MinIO 实例</p>
    </div>

    <!-- 1. 文件选择 -->
    <div class="rounded-lg border border-default bg-default p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-semibold text-highlighted">1. 选择文件</h2>
        <label class="cursor-pointer">
          <input type="file" accept=".json" multiple class="hidden" @change="onFilesSelected">
          <NuxtButton color="primary" variant="outline" icon="i-lucide-file-plus" label="添加文件" as="span" />
        </label>
      </div>
      <div v-if="dispatch.files.value.length" class="flex flex-wrap gap-2">
        <div
          v-for="f in dispatch.files.value"
          :key="f.name"
          class="flex items-center gap-2 rounded-md border border-default bg-elevated px-3 py-1.5 text-sm"
        >
          <NuxtIcon name="i-lucide-file-json" class="size-4 text-primary" />
          <span class="font-mono">{{ f.name }}</span>
          <button
            v-if="!dispatch.isRunning.value"
            class="text-muted hover:text-error"
            @click="removeFile(f.name)"
          >
            <NuxtIcon name="i-lucide-x" class="size-3.5" />
          </button>
        </div>
      </div>
      <div v-else class="flex items-center gap-2 py-4 text-muted">
        <NuxtIcon name="i-lucide-inbox" class="size-5" />
        <span>点击"添加文件"选择 JSON 文件（可多选）</span>
      </div>
    </div>

    <!-- 2. 目标选择 -->
    <div class="rounded-lg border border-default bg-default p-4">
      <h2 class="mb-3 font-semibold text-highlighted">2. 选择目标</h2>
      <template v-for="g in groups" :key="g.id">
        <div class="rounded-md border border-default">
          <!-- 组行 -->
          <div class="flex items-center gap-3 p-3">
            <NuxtCheckbox
              :model-value="isGroupAllSelected(g)"
              :indeterminate="isGroupPartialSelected(g)"
              :disabled="!g.instances.filter(i => i.enabled).length"
              @update:model-value="toggleGroup(g)"
            />
            <button
              class="flex items-center gap-2 flex-1 text-left"
              @click="expanded[g.id] = !expanded[g.id]"
            >
              <NuxtIcon
                :name="expanded[g.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                class="size-4 text-muted"
              />
              <NuxtIcon name="i-lucide-folder" class="size-4 text-primary" />
              <span class="font-semibold text-highlighted">{{ g.name }}</span>
              <NuxtBadge color="neutral" variant="subtle" size="sm">
                {{ g.instances.filter(i => i.enabled).length }} 个启用
              </NuxtBadge>
            </button>
          </div>
          <!-- 实例行 -->
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
              <NuxtBadge v-if="inst.bucket" color="neutral" variant="outline" size="sm">{{ inst.bucket }}</NuxtBadge>
              <NuxtBadge v-if="!inst.enabled" color="neutral" variant="outline" size="sm">禁用</NuxtBadge>
            </div>
            <div v-if="!g.instances.length" class="px-6 py-3 text-sm text-muted">该组无实例</div>
          </div>
        </div>
      </template>
    </div>

    <!-- 3. bucket + 提交 -->
    <div class="flex items-end gap-4">
      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium text-muted">Bucket</label>
        <NuxtInput
          v-model="dispatch.bucket.value"
          placeholder="留空则用实例默认 bucket"
          class="w-64"
          :disabled="dispatch.isRunning.value"
        />
      </div>
      <div v-if="bucketOptions.length > 1" class="text-xs text-muted pb-2">
        选中实例有多个 bucket：{{ bucketOptions.join('、') }}
      </div>
      <div class="flex-1" />
      <div class="text-sm text-muted">
        已选 <span class="font-semibold text-highlighted">{{ selectedInstances.length }}</span> 个实例，
        {{ dispatch.files.value.length }} 个文件
      </div>
      <NuxtButton
        v-if="!dispatch.isRunning.value"
        color="primary"
        size="lg"
        icon="i-lucide-send"
        label="开始分发"
        :disabled="!dispatch.files.value.length || !selectedInstances.length"
        @click="onSubmit"
      />
      <NuxtButton
        v-else
        color="error"
        variant="outline"
        size="lg"
        icon="i-lucide-x"
        label="取消"
        @click="dispatch.cancel()"
      />
    </div>

    <!-- 4. 进度矩阵 -->
    <div v-if="showMatrix" class="rounded-lg border border-default bg-default p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-semibold text-highlighted">分发进度</h2>
        <div v-if="dispatch.taskSummary.value" class="flex items-center gap-3 text-sm">
          <span class="text-muted">共 {{ dispatch.taskSummary.value.total }}</span>
          <NuxtBadge color="success" variant="soft" size="sm">成功 {{ dispatch.taskSummary.value.success }}</NuxtBadge>
          <NuxtBadge color="error" variant="soft" size="sm">失败 {{ dispatch.taskSummary.value.failed }}</NuxtBadge>
        </div>
        <NuxtIcon v-else-if="dispatch.isRunning.value" name="i-lucide-loader-circle" class="size-5 animate-spin text-primary" />
      </div>

      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead>
            <tr class="border-b border-default">
              <th class="px-3 py-2 text-left font-semibold text-highlighted">实例</th>
              <th class="px-3 py-2 text-left font-semibold text-highlighted">组</th>
              <th
                v-for="f in dispatch.files.value"
                :key="f.name"
                class="px-3 py-2 text-center font-semibold text-highlighted"
              >
                {{ f.name }}
              </th>
              <th class="px-3 py-2 text-center font-semibold text-highlighted">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in matrixRows"
              :key="row.instance.id"
              class="border-b border-default"
            >
              <td class="px-3 py-2 font-medium">{{ row.instance.name }}</td>
              <td class="px-3 py-2 text-muted">{{ row.groupName }}</td>
              <td
                v-for="cell in row.cells"
                :key="cell.fileName"
                class="px-3 py-2 text-center"
              >
                <template v-if="cell.status === 'running'">
                  <NuxtIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary mx-auto" />
                </template>
                <template v-else-if="cell.status === null">
                  <span class="text-muted">—</span>
                </template>
                <template v-else>
                  <NuxtTooltip v-if="cell.status.status === 'success'">
                    <NuxtIcon name="i-lucide-check-circle" class="size-4 text-success mx-auto" />
                    <template #content>
                      成功 · {{ cell.status.duration }}ms
                    </template>
                  </NuxtTooltip>
                  <NuxtTooltip v-else>
                    <NuxtIcon name="i-lucide-x-circle" class="size-4 text-error mx-auto" />
                    <template #content>
                      失败 · {{ cell.status.error }}
                    </template>
                  </NuxtTooltip>
                </template>
              </td>
              <td class="px-3 py-2 text-center">
                <NuxtButton
                  v-if="row.cells.some(c => c.status && typeof c.status === 'object' && c.status.status === 'failed') && !dispatch.isRunning.value"
                  size="xs"
                  color="warning"
                  variant="ghost"
                  icon="i-lucide-rotate-ccw"
                  label="重试"
                  @click="retryInstance(row.instance.id)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
