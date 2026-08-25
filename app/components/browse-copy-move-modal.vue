<script setup lang="ts">
/**
 * 复制/移动弹窗
 *
 * 三阶段：选择目标 -> 进度 -> 完成
 * 复制和移动共用同一套 UI，移动完成后增加删除源对象步骤。
 * 改造后：POST 提交获取 taskId，通过 useTaskManager 订阅 SSE 进度。
 * 执行阶段可"后台继续"，任务在后端独立执行。
 */

import type { InstanceGroup } from '#shared/schemas/groups'
import type { TaskState, FileResult } from '#shared/schemas/task'

interface CopyTarget {
  instanceId: string
  instanceName: string
  bucket: string
  prefix: string
}

interface ProgressItem {
  key: string
  name: string
  status: FileResult['status']
  error?: string
  duration?: number
  sourceDeleteStatus?: 'deleted' | 'delete-failed'
  sourceDeleteError?: string
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
  /** 任务终态时触发，payload 为源/目标实例 ID（父组件据此刷新对应 tab，而非当前激活 tab） */
  complete: [sourceInstanceId: string, targetInstanceId: string]
}>()

const toast = useToast()
const taskManager = useTaskManager()

type Phase = 'select' | 'progress' | 'done'
const phase = ref<Phase>('select')

// ==================== 选择阶段 ====================

const targetInstanceId = ref<string>('')
const targetBucket = ref<string>('')
const targetPrefix = ref<string>('')

/**
 * 重试收窄后的源 key 集（retryFailed 设置）。
 * 非空时提交只包含这些 key；弹窗重新打开时清空。
 */
const retryKeys = ref<Set<string> | null>(null)

/** 目标实例的 bucket 列表（从 API 拉取） */
const targetBuckets = ref<string[]>([])
const targetBucketsLoading = ref(false)

const effectiveKeys = computed<Set<string>>(() => {
  // 重试模式：只提交上次失败的 key（目标保持不变）
  if (retryKeys.value) return retryKeys.value
  if (props.singleTarget)
    return props.singleTarget.type === 'object'
      ? new Set([props.singleTarget.key])
      : new Set<string>()
  return props.selectedKeys
})
const effectivePrefixes = computed<Set<string>>(() => {
  // 重试模式：失败项已展开为具体 key，不再提交前缀
  if (retryKeys.value) return new Set<string>()
  if (props.singleTarget)
    return props.singleTarget.type === 'folder'
      ? new Set([props.singleTarget.key])
      : new Set<string>()
  return props.selectedPrefixes
})

const sourceSelectedCount = computed(() => effectiveKeys.value.size + effectivePrefixes.value.size)

/**
 * 目标实例启用列表（保留分组信息）。
 */
const enabledInstancesWithGroup = computed(() =>
  props.groups.flatMap((g) =>
    g.instances
      .filter((i) => i.enabled)
      .map((i) => ({ ...i, groupName: g.name })),
  ),
)

const validTargets = computed<CopyTarget[]>(() => {
  if (!targetInstanceId.value || !targetBucket.value) return []
  return [
    {
      instanceId: targetInstanceId.value,
      instanceName: enabledInstancesWithGroup.value.find((i) => i.id === targetInstanceId.value)?.name ?? '',
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

const canSubmit = computed(
  () => sourceSelectedCount.value > 0 && validTargets.value.length > 0 && !isSamePath.value,
)

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

// ==================== 进度阶段（useTaskManager） ====================

/** 当前任务 ID */
const currentTaskId = ref<string | null>(null)

/** 从 useTaskManager 全局状态匹配当前任务 */
const currentTask = computed<TaskState | null>(() => {
  if (!currentTaskId.value) return null
  const inActive = taskManager.activeTasks.value.find(t => t.taskId === currentTaskId.value)
  if (inActive) return inActive
  const inQueue = taskManager.queueTasks.value.find(t => t.taskId === currentTaskId.value)
  if (inQueue) return inQueue
  return taskManager.completedTasks.value.find(t => t.taskId === currentTaskId.value) ?? null
})

/** 当前阶段（copy/move 共用，move 有 'deleting'） */
const currentPhase = computed(() => currentTask.value?.currentPhase ?? 'copying')

/** 任务状态 */
const taskStatus = computed(() => currentTask.value?.status ?? 'queued')

/** 文件列表从 fileProgress.results 渲染 */
const progressItems = computed<ProgressItem[]>(() => {
  const results = currentTask.value?.fileProgress?.results ?? {}
  return Object.entries(results).map(([key, result]) => ({
    key,
    name: key.split('/').pop() ?? key,
    status: result.status,
    error: result.error,
    duration: result.duration,
    sourceDeleteStatus: result.sourceDeleteStatus,
    sourceDeleteError: result.sourceDeleteError,
  }))
})

/** 总对象数 */
const totalObjects = computed(() => progressItems.value.length)

/** 复制完成数 */
const copyCompleted = computed(() =>
  progressItems.value.filter(i => i.status === 'success' || i.status === 'failed').length,
)

/** 删源完成数（move 专属） */
const deleteCompleted = computed(() =>
  progressItems.value.filter(i => i.sourceDeleteStatus === 'deleted' || i.sourceDeleteStatus === 'delete-failed').length,
)

/** 待删源总数（复制成功的数量） */
const toDeleteCount = computed(() =>
  progressItems.value.filter(i => i.status === 'success').length,
)

/** 进度百分比 */
const progressPercent = computed(() => {
  const total = totalObjects.value
  if (total <= 0) return 0
  if (props.mode === 'move' && currentPhase.value === 'deleting') {
    // 删除阶段：删源完成数 / 待删源总数
    const toDelete = toDeleteCount.value
    return toDelete <= 0 ? 0 : (deleteCompleted.value / toDelete) * 100
  }
  // 复制阶段：复制完成数 / 总数
  return (copyCompleted.value / total) * 100
})

const summary = computed(() => currentTask.value?.summary ?? null)

// ==================== 提交执行 ====================

async function startTransfer() {
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
    const { taskId } = await $fetch<{ taskId: string }>(
      `/api/browse/objects/${props.mode}`,
      { method: 'POST', body },
    )

    currentTaskId.value = taskId
    phase.value = 'progress'
    // 重试任务已提交，退出重试模式（后续重开弹窗走正常流程）
    retryKeys.value = null
    // 记录任务引用（供重开弹窗后的终态兜底 watch 使用）
    lastTaskRef = {
      taskId,
      source: props.sourceInstanceId,
      target: targetInstanceId.value,
    }
    completeEmitted = false
    await taskManager.subscribeTask(taskId)
  } catch (e: unknown) {
    const err = e instanceof Error ? e.message : '请求失败'
    toast.add({
      title: `${props.mode === 'copy' ? '复制' : '移动'}失败`,
      description: err,
      color: 'error',
    })
    phase.value = 'select'
  }
}

// ==================== 后台继续 ====================

function background() {
  // 关闭弹窗，任务继续在后端执行
  // useTaskManager 仍持有订阅，TaskViewerButton 显示执行中状态
  emit('update:open', false)
}

// ==================== 完成/关闭 ====================

const isRunning = computed(() =>
  taskStatus.value === 'queued' || taskStatus.value === 'running',
)

const isDone = computed(() =>
  phase.value === 'done' ||
  taskStatus.value === 'done' ||
  taskStatus.value === 'cancelled' ||
  taskStatus.value === 'failed',
)

const failedItems = computed(() =>
  progressItems.value.filter(i => i.status === 'failed' || i.sourceDeleteStatus === 'delete-failed'),
)

// 监听任务终态，自动切换到 done
/** 任务终态是否已通知父组件刷新（避免关闭弹窗时重复刷新） */
let completeEmitted = false

/**
 * 最近一次提交的任务引用（不受弹窗重开影响）。
 * 后台继续后重开弹窗会清空 currentTaskId，导致 watch(taskStatus) 感知不到
 * 旧任务终态；用此引用从 completedTasks 里兜底捕获终态，保证刷新不丢。
 */
let lastTaskRef: { taskId: string, source: string, target: string } | null = null

watch(taskStatus, (status) => {
  if (status === 'done' || status === 'cancelled' || status === 'failed') {
    phase.value = 'done'
    // 任务终态即刷新父组件对象列表（不等用户关闭弹窗）
    if (!completeEmitted) {
      completeEmitted = true
      emit('complete', props.sourceInstanceId, targetInstanceId.value)
    }
    const s = summary.value
    const actionLabel = props.mode === 'copy' ? '复制' : '移动'
    if (status === 'cancelled') {
      const parts = [`已取消`]
      if (s) {
        parts.push(`${s.success} 成功`)
        if (s.failed > 0) parts.push(`${s.failed} 失败`)
        if (s.skipped > 0) parts.push(`${s.skipped} 跳过`)
      }
      toast.add({
        title: `${actionLabel}${parts.join('，')}`,
        color: 'warning',
      })
      if (props.mode === 'move') {
        toast.add({
          title: '移动非原子操作',
          description: '可能出现源和目标都存在副本的情况，请手动检查并清理重复对象。',
          color: 'warning',
        })
      }
    } else if (s) {
      if (s.failed > 0) {
        toast.add({
          title: `${actionLabel}完成：${s.success} 成功，${s.failed} 失败`,
          color: 'warning',
        })
        if (props.mode === 'move') {
          toast.add({
            title: '移动非原子操作',
            description: '可能出现源和目标都存在副本的情况，请手动检查并清理重复对象。',
            color: 'warning',
          })
        }
      } else {
        toast.add({
          title: `${actionLabel}完成：${s.success} 个对象`,
          color: 'success',
        })
      }
    } else if (status === 'failed') {
      toast.add({ title: `${actionLabel}失败`, color: 'error' })
    }
  }
})

/**
 * 兜底：后台继续后重开弹窗（currentTaskId 被清空）导致主 watch 失效时，
 * 从 completedTasks 捕获 lastTaskRef 任务的终态，补发刷新。
 */
watch(() => taskManager.completedTasks.value, (tasks) => {
  if (!lastTaskRef || completeEmitted) return
  const done = tasks.find(t => t.taskId === lastTaskRef!.taskId)
  if (!done) return
  completeEmitted = true
  emit('complete', lastTaskRef.source, lastTaskRef.target)
}, { deep: true })

function onClose() {
  if (isDone.value && !completeEmitted) {
    completeEmitted = true
    emit('complete', props.sourceInstanceId, targetInstanceId.value)
  }
  emit('update:open', false)
}

/** 从弹窗取消任务（排队中取消不会触发 SSE 事件，需手动处理弹窗状态） */
async function cancelFromModal() {
  if (!currentTaskId.value) return
  await taskManager.cancelTask(currentTaskId.value)
  // 排队取消后后端不 emit cancelled，弹窗需要手动切换到完成态
  phase.value = 'done'
  const actionLabel = props.mode === 'copy' ? '复制' : '移动'
  toast.add({
    title: `${actionLabel}已取消`,
    color: 'warning',
  })
}

function retryFailed() {
  // 收集失败项的 key（复制失败 + 删源失败均重试）
  const failedKeys = new Set(
    progressItems.value
      .filter(i => i.status === 'failed' || i.sourceDeleteStatus === 'delete-failed')
      .map(i => i.key),
  )

  if (failedKeys.size === 0) return

  // 收窄源为失败项，目标保持不变，回到选择阶段（可调整后重新提交）
  retryKeys.value = failedKeys
  currentTaskId.value = null
  phase.value = 'select'
  toast.add({
    title: `已收集 ${failedKeys.size} 个失败项`,
    description: '目标保持不变，点击「开始重试」重新提交',
    color: 'info',
  })
}

watch(
  () => props.open,
  (open: boolean) => {
    if (open) {
      phase.value = 'select'
      targetInstanceId.value = ''
      targetBucket.value = ''
      targetPrefix.value = ''
      currentTaskId.value = null
      completeEmitted = false
      retryKeys.value = null
    }
  },
)

const titleText = computed(() => (props.mode === 'copy' ? '复制到' : '移动到'))
const isRetry = computed(() => retryKeys.value !== null)
const actionLabel = computed(() => {
  if (isRetry.value) return '开始重试'
  return props.mode === 'copy' ? '开始复制' : '开始移动'
})

/** 队列位置 */
const queuePosition = computed(() => currentTask.value?.queuePosition ?? null)
</script>

<template>
  <div>
    <NuxtModal
      :open="open"
      :title="titleText"
      :ui="{ content: 'w-[calc(100vw-2rem)] max-w-2xl' }"
      @update:open="
        (v: boolean) => {
          if (!v) onClose()
        }
      "
    >
      <template #body>
        <!-- 选择阶段 -->
        <div v-if="phase === 'select'" class="flex flex-col gap-4">
          <div
            v-if="isRetry"
            class="bg-info/10 text-info flex items-center gap-2 rounded-md p-3"
          >
            <NuxtIcon name="i-lucide-rotate-cw" class="size-4 shrink-0" />
            <span class="text-sm">重试模式：仅重新提交上次失败的 {{ effectiveKeys.size }} 个对象</span>
          </div>
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
                :items="enabledInstancesWithGroup.map((i) => ({ label: `${i.groupName} / ${i.name}`, value: i.id }))"
                value-key="value"
                placeholder="选择实例"
                class="flex-1"
              >
                <template #default>
                  <span v-if="targetInstanceId">
                    {{ enabledInstancesWithGroup.find((i) => i.id === targetInstanceId)?.groupName }} / {{ enabledInstancesWithGroup.find((i) => i.id === targetInstanceId)?.name }}
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

        <!-- 进度阶段 -->
        <div v-else-if="phase === 'progress'" class="flex flex-col gap-3">
          <!-- 源 -> 目标路径 -->
          <div class="bg-elevated rounded-md p-3">
            <div class="text-muted text-xs">源</div>
            <div class="text-highlighted font-mono text-sm">
              {{ sourceInstanceName }} / {{ sourceBucket }} / {{ sourcePrefix || '(根目录)' }}
            </div>
            <div class="text-muted mt-2 text-xs">目标</div>
            <div class="text-highlighted font-mono text-sm">
              {{ validTargets[0]?.instanceName }} / {{ validTargets[0]?.bucket }} / {{ validTargets[0]?.prefix || '(根目录)' }}
            </div>
          </div>

          <!-- 排队中提示 -->
          <div v-if="taskStatus === 'queued'" class="flex items-center gap-2 py-4">
            <NuxtIcon name="i-lucide-loader-circle" class="text-primary size-5 animate-spin" />
            <span class="text-sm">排队中（第 {{ queuePosition ?? '?' }} 位）</span>
          </div>

          <!-- 执行中 -->
          <template v-else>
            <div class="text-muted text-sm">
              <span v-if="mode === 'move' && currentPhase === 'deleting'">删除源对象中...</span>
              <span v-else>{{ mode === 'copy' ? '复制中' : '移动中' }}</span>
              · 共 {{ totalObjects }} 个对象
            </div>

            <div class="flex items-center gap-2">
              <div class="bg-default h-2 flex-1 overflow-hidden rounded-full">
                <div
                  class="bg-primary h-full transition-all"
                  :style="{ width: `${progressPercent}%` }"
                />
              </div>
              <span class="text-muted text-xs">
                <template v-if="mode === 'move' && currentPhase === 'deleting'">
                  {{ deleteCompleted }}/{{ toDeleteCount }}
                </template>
                <template v-else>
                  {{ copyCompleted }}/{{ totalObjects }}
                </template>
              </span>
            </div>

            <div class="bg-elevated max-h-72 overflow-y-auto rounded-md p-2">
              <div class="ml-2">
                <div
                  v-for="item in progressItems"
                  :key="item.key"
                  class="flex items-center gap-2 py-1 text-xs"
                >
                  <span class="truncate font-mono">{{ item.name }}</span>
                  <div class="ml-auto flex shrink-0 items-center gap-3">
                    <!-- 复制状态 -->
                    <span v-if="item.status === 'success'" class="text-success flex items-center gap-0.5">
                      复制 <NuxtIcon name="i-lucide-check" class="size-3" />
                    </span>
                    <span v-else-if="item.status === 'failed'" class="text-error flex items-center gap-0.5" :title="item.error">
                      复制 <NuxtIcon name="i-lucide-x" class="size-3" />
                    </span>
                    <span v-else-if="item.status === 'running'" class="text-primary flex items-center gap-0.5">
                      复制 <NuxtIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />
                    </span>
                    <span v-else class="text-muted flex items-center gap-0.5">
                      复制 <NuxtIcon name="i-lucide-minus" class="size-3" />
                    </span>
                    <!-- 移动专用：删源状态 -->
                    <template v-if="mode === 'move'">
                      <span v-if="item.sourceDeleteStatus === 'deleted'" class="text-muted flex items-center gap-0.5">
                        删源 <NuxtIcon name="i-lucide-check" class="size-3" />
                      </span>
                      <span v-else-if="item.sourceDeleteStatus === 'delete-failed'" class="text-error flex items-center gap-0.5" :title="item.sourceDeleteError">
                        删源 <NuxtIcon name="i-lucide-x" class="size-3" />
                      </span>
                      <span v-else-if="item.status === 'success' && currentPhase === 'deleting'" class="text-muted flex items-center gap-0.5">
                        删源 <NuxtIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />
                      </span>
                      <span v-else class="text-muted flex items-center gap-0.5">
                        删源 <NuxtIcon name="i-lucide-minus" class="size-3" />
                      </span>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- 完成阶段 -->
        <div v-else-if="phase === 'done'" class="flex flex-col gap-3">
          <!-- 源 -> 目标路径 -->
          <div class="bg-elevated rounded-md p-3">
            <div class="text-muted text-xs">源</div>
            <div class="text-highlighted font-mono text-sm">
              {{ sourceInstanceName }} / {{ sourceBucket }} / {{ sourcePrefix || '(根目录)' }}
            </div>
            <div class="text-muted mt-2 text-xs">目标</div>
            <div class="text-highlighted font-mono text-sm">
              {{ validTargets[0]?.instanceName }} / {{ validTargets[0]?.bucket }} / {{ validTargets[0]?.prefix || '(根目录)' }}
            </div>
          </div>

          <!-- 汇总 -->
          <div v-if="summary" class="flex items-center gap-2">
            <NuxtIcon
              :name="summary.failed > 0 ? 'i-lucide-triangle-alert' : 'i-lucide-check-circle'"
              :class="summary.failed > 0 ? 'text-warning' : 'text-success'"
              class="size-5 shrink-0"
            />
            <span class="text-sm">
              <span class="text-muted">共 {{ summary.total }} 个对象，</span>
              <span class="text-success">{{ summary.success }} 成功</span>
              <span v-if="summary.failed > 0" class="text-error">
                ，{{ summary.failed }} 失败
              </span>
              <span v-if="summary.skipped > 0" class="text-muted">
                ，{{ summary.skipped }} 跳过
              </span>
            </span>
          </div>

          <!-- 移动非原子提示 -->
          <div
            v-if="mode === 'move' && (summary?.failed ?? 0) > 0"
            class="bg-warning/10 text-warning flex items-start gap-2 rounded-md p-3"
          >
            <NuxtIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" />
            <span class="text-sm">移动非原子操作，可能出现源和目标都存在副本的情况，请手动检查并清理重复对象。</span>
          </div>

          <!-- 完整文件列表 -->
          <div class="bg-elevated max-h-72 overflow-y-auto rounded-md p-2">
            <div class="ml-2">
              <div
                v-for="item in progressItems"
                :key="item.key"
                class="flex items-center gap-2 py-1 text-xs"
              >
                <span class="truncate font-mono">{{ item.name }}</span>
                <div class="ml-auto flex shrink-0 items-center gap-3">
                  <!-- 复制状态 -->
                  <span v-if="item.status === 'success'" class="text-success flex items-center gap-0.5">
                    复制 <NuxtIcon name="i-lucide-check" class="size-3" />
                  </span>
                  <span v-else class="text-error flex items-center gap-0.5" :title="item.error">
                    复制 <NuxtIcon name="i-lucide-x" class="size-3" />
                  </span>
                  <!-- 移动专用：删源状态 -->
                  <template v-if="mode === 'move'">
                    <span v-if="item.sourceDeleteStatus === 'deleted'" class="text-muted flex items-center gap-0.5">
                      删源 <NuxtIcon name="i-lucide-check" class="size-3" />
                    </span>
                    <span v-else-if="item.sourceDeleteStatus === 'delete-failed'" class="text-error flex items-center gap-0.5" :title="item.sourceDeleteError">
                      删源 <NuxtIcon name="i-lucide-x" class="size-3" />
                    </span>
                    <span v-else class="text-muted flex items-center gap-0.5">
                      删源 <NuxtIcon name="i-lucide-minus" class="size-3" />
                    </span>
                  </template>
                </div>
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
          <!-- 执行中：可取消 / 后台继续 -->
          <template v-else-if="phase === 'progress' && isRunning">
            <NuxtButton
              v-if="taskStatus === 'queued'"
              color="neutral"
              variant="ghost"
              label="取消排队"
              @click="cancelFromModal"
            />
            <NuxtButton
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-left"
              label="后台继续"
              @click="background"
            />
          </template>
          <!-- 完成阶段 -->
          <template v-else-if="phase === 'done'">
            <NuxtButton
              v-if="failedItems.length > 0"
              color="warning"
              variant="outline"
              icon="i-lucide-rotate-cw"
              label="重试失败项"
              @click="retryFailed"
            />
            <NuxtButton color="primary" label="关闭" @click="onClose" />
          </template>
        </div>
      </template>
    </NuxtModal>
  </div>
</template>
