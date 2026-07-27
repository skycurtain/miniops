<script setup lang="ts">
/**
 * 复制/移动弹窗
 *
 * 三阶段：选择目标 -> 进度 -> 完成
 * 复制和移动共用同一套 UI，移动完成后增加删除源对象步骤。
 * 进度通过全局 useTransferTask composable 管理（useState），支持后台运行 + 跨页面恢复。
 */

import type { InstanceGroup } from '#shared/schemas/groups'
import type { TransferEndpoint } from '#shared/schemas/transfer'

interface CopyTarget {
  instanceId: string
  instanceName: string
  bucket: string
  prefix: string
}

const props = defineProps<{
  open: boolean
  mode: 'copy' | 'move'
  groups: InstanceGroup[]
  sourceInstanceId: string
  sourceInstanceName: string
  sourceBucket: string
  sourcePrefix: string
  selectedKeys: Set<string>
  selectedPrefixes: Set<string>
  singleTarget?: { type: 'object' | 'folder'; key: string } | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  complete: []
}>()

const toast = useToast()
const { activeTask, startTransfer: startTransferTask, resumeTask, clearTask } = useTransferTask()

/** 弹窗当前阶段：有全局任务时跟随任务阶段，否则 select */
type Phase = 'select' | 'scanning' | 'progress' | 'deleting' | 'done'
const phase = computed<Phase>(() => {
  if (!activeTask.value || activeTask.value.type !== props.mode) return 'select'
  switch (activeTask.value.phase) {
    case 'scanning': return 'scanning'
    case 'progress': return 'progress'
    case 'deleting': return 'deleting'
    case 'done': return 'done'
    default: return 'select'
  }
})

/** 是否有正在进行的任务（控制弹窗不可关闭） */
const isRunning = computed(() =>
  phase.value === 'scanning' || phase.value === 'progress' || phase.value === 'deleting',
)

// ==================== 选择阶段 ====================

const targetInstanceId = ref<string>('')
const targetBucket = ref<string>('')
const targetPrefix = ref<string>('')

/** 目标实例的 bucket 列表（从 API 拉取） */
const targetBuckets = ref<string[]>([])
const targetBucketsLoading = ref(false)

const effectiveKeys = computed(() =>
  props.singleTarget
    ? props.singleTarget.type === 'object'
      ? new Set([props.singleTarget.key])
      : new Set<string>()
    : props.selectedKeys,
)
const effectivePrefixes = computed(() =>
  props.singleTarget
    ? props.singleTarget.type === 'folder'
      ? new Set([props.singleTarget.key])
      : new Set<string>()
    : props.selectedPrefixes,
)

const sourceSelectedCount = computed(() => effectiveKeys.value.size + effectivePrefixes.value.size)

const enabledInstances = computed(() =>
  props.groups.flatMap((g) => g.instances.filter((i) => i.enabled)),
)

const validTargets = computed<CopyTarget[]>(() => {
  if (!targetInstanceId.value || !targetBucket.value) return []
  return [
    {
      instanceId: targetInstanceId.value,
      instanceName: enabledInstances.value.find((i) => i.id === targetInstanceId.value)?.name ?? '',
      bucket: targetBucket.value,
      prefix: targetPrefix.value.trim(),
    },
  ]
})

const isSamePath = computed(
  () =>
    isSourceInstance(targetInstanceId.value) &&
    targetBucket.value === props.sourceBucket &&
    targetPrefix.value.trim() === props.sourcePrefix,
)

const canSubmit = computed(() => {
  // 有全局任务进行中时禁止提交
  if (activeTask.value && activeTask.value.phase !== 'done') return false
  return sourceSelectedCount.value > 0 && validTargets.value.length > 0 && !isSamePath.value
})

function isSourceInstance(instanceId: string): boolean {
  return instanceId === props.sourceInstanceId
}

/** 目标实例变化时拉取 bucket 列表 */
watch(targetInstanceId, async (id) => {
  targetBucket.value = ''
  targetBuckets.value = []
  if (!id) return
  targetBucketsLoading.value = true
  try {
    const res = await $fetch<{ buckets: { name: string; createdAt: string }[]; error?: string }>(
      '/api/browse/buckets',
      { query: { instanceId: id } },
    )
    if (res.error) {
      toast.add({ title: '获取 bucket 列表失败', description: res.error, color: 'error' })
    } else {
      targetBuckets.value = res.buckets.map((b) => b.name)
    }
  } catch {
    toast.add({ title: '获取 bucket 列表失败', color: 'error' })
  } finally {
    targetBucketsLoading.value = false
  }
})

// ==================== 进度阶段（读全局状态） ====================

const progressExpanded = ref<Record<string, boolean>>({})

const totalObjects = computed(() => activeTask.value?.total ?? 0)
const totalCompleted = computed(() => activeTask.value?.completed ?? 0)
const totalItems = computed(() => activeTask.value?.total ?? 0)

const progressPercent = computed(() => {
  const total = totalItems.value
  if (total <= 0) return 0
  return (totalCompleted.value / total) * 100
})


/** 进度项列表（从全局 task.results 映射） */
const progressItems = computed(() => activeTask.value?.results ?? [])
const deletingSource = computed(() => activeTask.value?.deletingSource ?? false)

const failedItems = computed(() => {
  if (!activeTask.value) return []
  return activeTask.value.results
    .filter((r) => r.status === 'failed')
    .map((r) => ({
      target: `${activeTask.value!.target.instanceName} / ${activeTask.value!.target.bucket}`,
      name: r.name,
      error: r.error ?? '未知错误',
    }))
})

/** 完成时的 toast 通知 */
const doneToastShown = ref(false)
watch(phase, (p) => {
  if (p === 'done' && !doneToastShown.value) {
    doneToastShown.value = true
    const task = activeTask.value!
    const actionLabel = task.type === 'copy' ? '复制' : '移动'
    if (task.failed > 0) {
      toast.add({
        title: `${actionLabel}完成：${task.success} 成功，${task.failed} 失败`,
        color: 'warning',
      })
    } else {
      toast.add({
        title: `${actionLabel}完成：${task.success} 个对象`,
        color: 'success',
      })
    }
  }
  if (p === 'select') {
    doneToastShown.value = false
  }
})

// ==================== 执行 ====================

async function startTransfer() {
  const target = validTargets.value[0]!
  const source: TransferEndpoint = {
    instanceId: props.sourceInstanceId,
    instanceName: props.sourceInstanceName,
    bucket: props.sourceBucket,
    prefix: props.sourcePrefix,
  }
  const targetEndpoint: TransferEndpoint = {
    instanceId: target.instanceId,
    instanceName: target.instanceName,
    bucket: target.bucket,
    prefix: target.prefix,
  }

  const body = {
    sourceInstanceId: props.sourceInstanceId,
    sourceBucket: props.sourceBucket,
    sourcePrefix: props.sourcePrefix,
    keys: [...effectiveKeys.value],
    prefixes: [...effectivePrefixes.value],
    targetInstanceId: targetInstanceId.value,
    targetBucket: targetBucket.value,
    targetPrefix: targetPrefix.value.trim(),
  }

  try {
    await startTransferTask(props.mode, body, { source, target: targetEndpoint })
    progressExpanded.value[target.instanceId] = true
  } catch {
    toast.add({
      title: `${props.mode === 'copy' ? '复制' : '移动'}失败`,
      color: 'error',
    })
  }
}

// ==================== 后台运行 ====================

function runInBackground() {
  emit('update:open', false)
}

// ==================== 完成/关闭 ====================

function onClose() {
  if (phase.value === 'done') {
    emit('complete')
    clearTask()
  }
  targetInstanceId.value = ''
  targetBucket.value = ''
  targetPrefix.value = ''
  emit('update:open', false)
}

function cancelTransfer() {
  // 取消只是关闭弹窗，任务在后端继续执行
  // 用户可通过悬浮指示器恢复
  emit('update:open', false)
}

/** 弹窗打开时：如果有全局任务在跑，恢复 SSE 订阅 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      if (activeTask.value && activeTask.value.phase !== 'done') {
        // 恢复已有任务的 SSE
        resumeTask()
      } else if (!activeTask.value || activeTask.value.phase === 'done') {
        // 没有任务或已完成，重置选择阶段
        if (activeTask.value?.phase === 'done') {
          clearTask()
        }
        targetInstanceId.value = ''
        targetBucket.value = ''
        targetPrefix.value = ''
      }
    }
  },
)

const titleText = computed(() => (props.mode === 'copy' ? '复制到' : '移动到'))
const actionLabel = computed(() => (props.mode === 'copy' ? '开始复制' : '开始移动'))
</script>

<template>
  <div>
    <NuxtModal
      :open="open"
      :title="titleText"
      :dismissible="!isRunning"
      :ui="{ content: 'w-[calc(100vw-2rem)] max-w-2xl' }"
      @update:open="
        (v: boolean) => {
          if (!v && !isRunning) onClose()
        }
      "
    >
      <template #body>
        <!-- 选择阶段 -->
        <div v-if="phase === 'select'" class="flex flex-col gap-4">
          <div class="bg-elevated rounded-md p-3">
            <div class="text-muted text-xs">源</div>
            <div class="text-highlighted mt-1 font-mono text-sm">
              {{ sourceInstanceName }} / {{ sourceBucket }} / {{ sourcePrefix || '(根目录)' }}
            </div>
            <div class="text-muted mt-1 text-xs">
              已选：{{ effectiveKeys.size }} 个对象，{{ effectivePrefixes.size }} 个文件夹
            </div>
          </div>

          <div class="flex flex-col gap-3">
            <div class="flex items-center gap-2">
              <span class="text-muted w-24 shrink-0 text-sm">目标实例：</span>
              <NuxtSelectMenu
                v-model="targetInstanceId"
                :items="enabledInstances.map((i) => ({ label: i.name, value: i.id }))"
                value-key="value"
                placeholder="选择实例"
                class="flex-1"
              >
                <template #default>
                  <span v-if="targetInstanceId">
                    {{ enabledInstances.find((i) => i.id === targetInstanceId)?.name }}
                    <NuxtBadge
                      v-if="isSourceInstance(targetInstanceId)"
                      color="neutral"
                      variant="outline"
                      size="sm"
                      class="ml-1"
                      >源实例</NuxtBadge
                    >
                  </span>
                  <span v-else class="text-muted">选择实例</span>
                </template>
              </NuxtSelectMenu>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-muted w-24 shrink-0 text-sm">目标 Bucket：</span>
              <NuxtSelectMenu
                v-model="targetBucket"
                :items="targetBuckets.map((b) => ({
                  label: b,
                  value: b,
                  disabled: isSourceInstance(targetInstanceId) && b === sourceBucket,
                }))"
                value-key="value"
                placeholder="选择 bucket"
                :disabled="!targetInstanceId"
                :loading="targetBucketsLoading"
                class="flex-1"
              >
                <template #default>
                  <span v-if="targetBucket" class="font-mono text-sm">
                    {{ targetBucket }}
                    <span
                      v-if="isSourceInstance(targetInstanceId) && targetBucket === sourceBucket"
                      class="text-warning"
                      >（源 bucket）</span
                    >
                  </span>
                  <span v-else class="text-muted">选择 bucket</span>
                </template>
              </NuxtSelectMenu>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-muted w-24 shrink-0 text-sm">目标前缀：</span>
              <NuxtInput v-model="targetPrefix" placeholder="留空 = bucket 根" class="flex-1" />
            </div>
            <div
              v-if="mode === 'move'"
              class="bg-warning/10 text-warning flex items-center gap-2 rounded-md p-3"
            >
              <NuxtIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" />
              <span class="text-sm">移动 = 复制到目标 + 删除源对象</span>
            </div>
            <div v-if="isSamePath" class="text-error text-xs">
              目标路径与源路径相同，请选择不同的 bucket 或前缀
            </div>
            <div v-else class="text-muted text-xs">同 bucket 不同前缀可复制/移动</div>
          </div>
        </div>

        <!-- 扫描阶段 -->
        <div v-else-if="phase === 'scanning'" class="flex flex-col gap-3">
          <div class="flex items-center gap-2 py-4">
            <NuxtIcon name="i-lucide-loader-circle" class="text-primary size-5 animate-spin" />
            <span class="text-sm">扫描中...</span>
          </div>
        </div>

        <!-- 进度阶段 -->
        <div v-else-if="phase === 'progress' || phase === 'deleting'" class="flex flex-col gap-3">
          <div class="text-muted text-sm">
            {{ activeTask?.source.instanceName }} / {{ activeTask?.source.bucket }}
            ->
            {{ activeTask?.target.instanceName }} / {{ activeTask?.target.bucket }}
          </div>

          <div class="text-muted text-sm">共 {{ totalObjects }} 个对象</div>

          <div class="flex items-center gap-2">
            <div class="bg-default h-2 flex-1 overflow-hidden rounded-full">
              <div
                class="bg-primary h-full transition-all"
                :style="{ width: `${progressPercent}%` }"
              />
            </div>
            <span class="text-muted text-xs">{{ totalCompleted }}/{{ totalItems }}</span>
          </div>

          <div class="bg-elevated max-h-72 overflow-y-auto rounded-md p-2">
            <div class="mb-2">
              <button
                class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
                @click="progressExpanded[activeTask!.target.instanceId] = !progressExpanded[activeTask!.target.instanceId]"
              >
                <NuxtIcon
                  :name="progressExpanded[activeTask!.target.instanceId] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  class="text-muted size-4"
                />
                <NuxtIcon name="i-lucide-server" class="text-muted size-4" />
                <span class="text-sm font-medium">
                  {{ activeTask?.target.instanceName }} / {{ activeTask?.target.bucket }}
                </span>
                <span class="text-muted ml-auto text-xs">{{ totalCompleted }}/{{ totalItems }}</span>
              </button>

              <div v-show="progressExpanded[activeTask!.target.instanceId]" class="ml-6">
                <div
                  v-for="item in progressItems"
                  :key="item.key"
                  class="flex items-center gap-2 py-1 text-xs"
                >
                  <NuxtIcon
                    v-if="item.status === 'success'"
                    name="i-lucide-check"
                    class="text-success size-3.5 shrink-0"
                  />
                  <NuxtIcon
                    v-else
                    name="i-lucide-x"
                    class="text-error size-3.5 shrink-0"
                  />
                  <span class="truncate font-mono">{{ item.name }}</span>
                  <span
                    v-if="item.status === 'failed'"
                    class="text-error ml-auto truncate"
                    :title="item.error"
                  >{{ item.error }}</span>
                </div>
              </div>

              <div
                v-if="deletingSource"
                class="text-warning ml-6 flex items-center gap-1 py-1 text-xs"
              >
                <NuxtIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
                <span>复制完成，正在删除源对象...</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 完成阶段 -->
        <div v-else-if="phase === 'done'" class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <NuxtIcon name="i-lucide-check-circle" class="text-success size-5 shrink-0" />
            <span class="text-sm">
              {{ activeTask?.target.instanceName }} / {{ activeTask?.target.bucket }}
              <span class="text-muted">
                {{ activeTask?.success }}/{{ activeTask?.total }} 成功
              </span>
              <span v-if="(activeTask?.failed ?? 0) > 0" class="text-error">
                ，{{ activeTask?.failed }} 失败
              </span>
            </span>
          </div>

          <div v-if="failedItems.length > 0" class="flex flex-col gap-1">
            <div class="text-muted text-sm font-medium">失败项：</div>
            <div class="bg-elevated max-h-40 overflow-y-auto rounded-md p-2">
              <div
                v-for="(item, idx) in failedItems"
                :key="idx"
                class="flex items-center gap-2 py-1 text-xs"
              >
                <NuxtIcon name="i-lucide-x" class="text-error size-3.5 shrink-0" />
                <span class="truncate font-mono">{{ item.name }}</span>
                <span class="text-muted shrink-0">{{ item.target }}</span>
                <span class="text-error ml-auto shrink-0">{{ item.error }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <template v-if="phase === 'select'">
            <NuxtButton color="neutral" variant="ghost" label="取消" @click="onClose" />
            <NuxtButton
              color="primary"
              :icon="mode === 'copy' ? 'i-lucide-copy' : 'i-lucide-folder-input'"
              :label="actionLabel"
              :disabled="!canSubmit"
              @click="startTransfer"
            />
          </template>
          <template v-else-if="isRunning">
            <NuxtButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-down-to-line"
              label="后台运行"
              @click="runInBackground"
            />
            <NuxtButton color="neutral" variant="ghost" label="关闭" @click="cancelTransfer" />
          </template>
          <template v-else-if="phase === 'done'">
            <NuxtButton color="primary" label="关闭" @click="onClose" />
          </template>
        </div>
      </template>
    </NuxtModal>
  </div>
</template>
