<script setup lang="ts">
import type { TaskState, TaskType, InstanceProgress, FileResult } from '#shared/schemas/task'

// ==================== 类型映射 ====================
const typeIconMap: Record<TaskType, string> = {
  dispatch: 'i-lucide-send',
  upload: 'i-lucide-upload',
  copy: 'i-lucide-copy',
  move: 'i-lucide-file-output',
}
const typeLabelMap: Record<TaskType, string> = {
  dispatch: '分发',
  upload: '上传',
  copy: '复制',
  move: '移动',
}

// ==================== 弹窗开关 ====================
const open = ref(false)

// 组件挂载时恢复任务状态（仅一次，后续靠 SSE 实时更新）：
// 1. 最近完成任务（“最近完成”区域）
// 2. 活跃任务（执行中 + 排队中）--刷新/重开页面后恢复显示，并重建 SSE 订阅
const { activeTasks, queueTasks, completedTasks, cancelTask, fetchCompleted, fetchActive, subscribeTask, markViewed } = useTaskManager()

onMounted(async () => {
  fetchCompleted().catch(() => {})
  try {
    const tasks = await fetchActive()
    // 对服务端仍在执行/排队的任务重建 SSE 订阅（进度实时更新）
    for (const task of tasks) {
      if (task.status === 'running' || task.status === 'queued') {
        void subscribeTask(task.taskId)
      }
    }
  } catch {
    // 拉取失败不阻塞挂载，静默
  }
})

watch(open, async (val) => {
  if (!val) return
  // 标记已查看（不覆盖 completedTasks，依赖响应式实时更新）
  const ids = completedTasks.value.map(t => t.taskId)
  if (ids.length) {
    try {
      await markViewed(ids)
    } catch {
      // 标记已查看失败不阻塞交互，静默
    }
  }
})

// ==================== 角标状态 ====================
const hasActive = computed(() => activeTasks.value.length > 0 || queueTasks.value.length > 0)
const activeCount = computed(() => activeTasks.value.length + queueTasks.value.length)

const unviewedFailed = computed(() =>
  completedTasks.value.filter(t =>
    !t.viewed
    // 两种失败形态都显示 ! 角标：
    // 1. status==='failed'：执行器抛异常（致命失败）
    // 2. status==='done' && summary.failed>0：部分文件失败（单文件失败不致命）
    && (t.status === 'failed' || (t.status === 'done' && (t.summary?.failed ?? 0) > 0)),
  ),
)

const unviewedCancelled = computed(() =>
  completedTasks.value.filter(t => !t.viewed && t.status === 'cancelled'),
)

const unviewedSuccess = computed(() =>
  completedTasks.value.filter(t => !t.viewed && t.status === 'done' && (t.summary?.failed ?? 0) === 0),
)

// 是否处于"全部成功且未查看"状态
const inAllSuccessState = computed(() =>
  !hasActive.value
  && unviewedFailed.value.length === 0
  && unviewedCancelled.value.length === 0
  && unviewedSuccess.value.length > 0,
)

// 成功角标 3 秒后消失
const successBadgeVisible = ref(false)
let successTimer: ReturnType<typeof setTimeout> | null = null

watch(inAllSuccessState, (val) => {
  if (val) {
    successBadgeVisible.value = true
    if (successTimer) clearTimeout(successTimer)
    successTimer = setTimeout(() => {
      successBadgeVisible.value = false
    }, 3000)
  } else {
    successBadgeVisible.value = false
    if (successTimer) {
      clearTimeout(successTimer)
      successTimer = null
    }
  }
}, { immediate: true })

onUnmounted(() => {
  if (successTimer) clearTimeout(successTimer)
})

const buttonIcon = computed(() => {
  if (hasActive.value) return 'i-lucide-loader-circle'
  if (unviewedFailed.value.length > 0) return 'i-lucide-triangle-alert'
  if (unviewedCancelled.value.length > 0) return 'i-lucide-circle-slash'
  if (inAllSuccessState.value) return 'i-lucide-check-circle'
  return 'i-lucide-list-checks'
})

const buttonIconClass = computed(() => {
  if (hasActive.value) return 'text-primary animate-spin'
  if (unviewedFailed.value.length > 0) return 'text-error'
  if (unviewedCancelled.value.length > 0) return 'text-warning'
  if (inAllSuccessState.value) return 'text-success'
  return 'text-muted'
})

const badge = computed(() => {
  if (hasActive.value) {
    return { show: true, content: String(activeCount.value), color: 'info' as const }
  }
  if (unviewedFailed.value.length > 0) {
    return { show: true, content: '!', color: 'error' as const }
  }
  if (unviewedCancelled.value.length > 0) {
    return { show: true, content: '!', color: 'warning' as const }
  }
  if (successBadgeVisible.value) {
    return { show: true, content: '✓', color: 'success' as const }
  }
  return { show: false, content: '', color: 'primary' as const }
})

// ==================== 详情展开（手风琴） ====================
const expandedTaskId = ref<string | null>(null)

/** 任务是否有可展开的文件详情 */
function hasFileDetails(task: TaskState): boolean {
  return !!task.fileProgress && Object.keys(task.fileProgress.results).length > 0
    || !!task.instanceProgress && task.instanceProgress.length > 0
}

function toggleExpand(taskId: string) {
  expandedTaskId.value = expandedTaskId.value === taskId ? null : taskId
}

// ==================== 进度计算 ====================
function getTaskProgress(task: TaskState) {
  // 执行中 summary 尚未生成，从 fileProgress 实时统计（与完成态口径一致：
  // success/failed/skipped 计入已完成）
  if (task.fileProgress?.results) {
    const results = Object.values(task.fileProgress.results)
    const total = results.length
    const done = results.filter(r =>
      r.status === 'success' || r.status === 'failed' || r.status === 'skipped',
    ).length
    return {
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
      done,
      total,
    }
  }
  const s = task.summary
  if (!s) return { percent: 0, done: 0, total: 0 }
  const done = s.success + s.failed + s.skipped
  return {
    percent: s.total > 0 ? Math.round((done / s.total) * 100) : 0,
    done,
    total: s.total,
  }
}

function getInstanceStats(inst: InstanceProgress) {
  const results = Object.values(inst.results)
  return {
    done: results.filter(r => r.status === 'success' || r.status === 'failed').length,
    total: results.length,
    failed: results.filter(r => r.status === 'failed').length,
  }
}

function fileResultIcon(r: FileResult): { name: string, class: string } {
  switch (r.status) {
    case 'success': return { name: 'i-lucide-check-circle', class: 'text-success' }
    case 'failed': return { name: 'i-lucide-x-circle', class: 'text-error' }
    case 'running': return { name: 'i-lucide-loader-circle', class: 'text-primary animate-spin' }
    case 'pending': return { name: 'i-lucide-clock', class: 'text-muted' }
    case 'skipped': return { name: 'i-lucide-minus-circle', class: 'text-muted' }
    default: return { name: 'i-lucide-circle', class: 'text-muted' }
  }
}

function completedResultIcon(task: TaskState): { name: string, class: string } {
  if (task.status === 'cancelled') return { name: 'i-lucide-circle-slash', class: 'text-muted' }
  if (task.status === 'failed') return { name: 'i-lucide-x-circle', class: 'text-error' }
  if (task.status === 'done' && (task.summary?.failed ?? 0) > 0) {
    return { name: 'i-lucide-triangle-alert', class: 'text-warning' }
  }
  return { name: 'i-lucide-check-circle', class: 'text-success' }
}

// ==================== 相对时间 ====================
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时前`
}

// ==================== move 阶段标签 ====================
function phaseLabel(phase?: string): string {
  if (phase === 'copying') return '复制中'
  if (phase === 'deleting') return '删除源中'
  return ''
}

// ==================== 取消任务 ====================
async function onCancel(taskId: string) {
  try {
    await cancelTask(taskId)
  } catch {
    // 取消失败由 composable / 后端处理
  }
}
</script>

<template>
  <NuxtPopover v-model:open="open" :ui="{ content: 'w-96 max-h-[80vh] overflow-y-auto' }">
    <NuxtButton color="neutral" variant="ghost" class="relative">
      <NuxtIcon :name="buttonIcon" :class="buttonIconClass" class="size-5" />
      <NuxtBadge
        v-if="badge.show"
        :color="badge.color"
        size="sm"
        class="absolute -top-1 -right-1"
      >
        {{ badge.content }}
      </NuxtBadge>
    </NuxtButton>

    <template #content>
      <div class="flex flex-col gap-3 p-3">
        <!-- ═══ 执行中 ═══ -->
        <div v-if="activeTasks.length" class="flex flex-col gap-1.5">
          <span class="text-muted text-xs font-semibold uppercase">执行中</span>
          <div v-for="task in activeTasks" :key="task.taskId" class="border-default rounded-md border">
            <!-- 概要行（可点击展开详情，手风琴模式） -->
            <div
              class="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-elevated/50"
              @click="toggleExpand(task.taskId)"
            >
              <NuxtIcon
                :name="expandedTaskId === task.taskId ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                class="text-muted size-4 shrink-0"
              />
              <NuxtIcon :name="typeIconMap[task.type]" class="text-primary size-4 shrink-0" />
              <span class="text-sm font-medium truncate flex-1">
                {{ task.description.label || typeLabelMap[task.type] }}
              </span>
              <NuxtBadge
                v-if="phaseLabel(task.currentPhase)"
                color="neutral"
                variant="subtle"
                size="sm"
                class="shrink-0"
              >
                {{ phaseLabel(task.currentPhase) }}
              </NuxtBadge>
              <span class="text-muted shrink-0 text-xs">{{ getTaskProgress(task).percent }}%</span>
            </div>
            <!-- 进度条 -->
            <div class="px-3 pb-2">
              <NuxtProgress :model-value="getTaskProgress(task).percent" size="xs" />
              <div v-if="task.summary" class="text-muted mt-1 text-xs">
                成功 {{ task.summary.success }} · 失败 {{ task.summary.failed }} · 跳过 {{ task.summary.skipped }}
              </div>
            </div>
            <!-- 详情区（手风琴展开，max-h-60 overflow-y-auto） -->
            <div
              v-if="expandedTaskId === task.taskId"
              class="border-default max-h-60 overflow-y-auto border-t px-3 py-2"
            >
              <!-- dispatch: 实例维度 -->
              <template v-if="task.type === 'dispatch' && task.instanceProgress">
                <div
                  v-for="inst in task.instanceProgress"
                  :key="inst.instanceId"
                  class="flex flex-col gap-1 pb-2 last:pb-0"
                >
                  <div class="flex items-center gap-2">
                    <NuxtIcon name="i-lucide-server" class="text-muted size-3.5 shrink-0" />
                    <span class="text-xs font-medium truncate">{{ inst.instanceName }}</span>
                    <span class="text-muted shrink-0 font-mono text-xs">{{ inst.bucket }}</span>
                    <div class="flex-1" />
                    <span class="text-muted shrink-0 text-xs">{{ getInstanceStats(inst).done }}/{{ getInstanceStats(inst).total }}</span>
                    <NuxtBadge
                      v-if="getInstanceStats(inst).failed"
                      color="error"
                      variant="soft"
                      size="sm"
                    >
                      {{ getInstanceStats(inst).failed }} 失败
                    </NuxtBadge>
                  </div>
                  <div class="flex flex-col pl-5">
                    <div
                      v-for="(result, key) in inst.results"
                      :key="key"
                      class="flex items-center gap-2 py-0.5"
                    >
                      <NuxtIcon
                        :name="fileResultIcon(result).name"
                        :class="fileResultIcon(result).class"
                        class="size-3.5 shrink-0"
                      />
                      <span class="text-muted truncate flex-1 font-mono text-xs">{{ key }}</span>
                      <span v-if="result.status === 'success'" class="text-muted shrink-0 text-xs">{{ result.duration }}ms</span>
                      <NuxtTooltip v-else-if="result.status === 'failed'">
                        <span class="text-error shrink-0 text-xs">失败</span>
                        <template #content>{{ result.error }}</template>
                      </NuxtTooltip>
                      <span v-else-if="result.status === 'running'" class="text-primary shrink-0 text-xs">进行中</span>
                      <span v-else-if="result.status === 'pending'" class="text-muted shrink-0 text-xs">等待中</span>
                      <span v-else class="text-muted shrink-0 text-xs">已跳过</span>
                    </div>
                  </div>
                </div>
              </template>
              <!-- 其他类型: 扁平文件维度 -->
              <template v-else-if="task.fileProgress">
                <div
                  v-for="(result, key) in task.fileProgress.results"
                  :key="key"
                  class="flex items-center gap-2 py-0.5"
                >
                  <NuxtIcon
                    :name="fileResultIcon(result).name"
                    :class="fileResultIcon(result).class"
                    class="size-3.5 shrink-0"
                  />
                  <span class="text-muted truncate flex-1 font-mono text-xs">{{ key }}</span>
                  <span v-if="result.status === 'success'" class="text-muted shrink-0 text-xs">{{ result.duration }}ms</span>
                  <NuxtTooltip v-else-if="result.status === 'failed'">
                    <span class="text-error shrink-0 text-xs">失败</span>
                    <template #content>{{ result.error }}</template>
                  </NuxtTooltip>
                  <span v-else-if="result.status === 'running'" class="text-primary shrink-0 text-xs">进行中</span>
                  <span v-else-if="result.status === 'pending'" class="text-muted shrink-0 text-xs">等待中</span>
                  <span v-else class="text-muted shrink-0 text-xs">已跳过</span>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- ═══ 排队中 ═══ -->
        <div v-if="queueTasks.length" class="flex flex-col gap-1.5">
          <span class="text-muted text-xs font-semibold uppercase">排队中（{{ queueTasks.length }}）</span>
          <div
            v-for="task in queueTasks"
            :key="task.taskId"
            class="border-default flex items-center gap-2 rounded-md border px-3 py-1.5"
          >
            <NuxtIcon :name="typeIconMap[task.type]" class="text-muted size-4 shrink-0" />
            <span class="text-sm truncate flex-1">{{ task.description.label || typeLabelMap[task.type] }}</span>
            <span class="text-muted shrink-0 text-xs">#{{ task.queuePosition ?? '-' }}</span>
            <NuxtButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-x"
              @click="onCancel(task.taskId)"
            />
          </div>
        </div>

        <!-- ═══ 最近完成（最多 10 条，可展开详情）═══ -->
        <div v-if="completedTasks.length" class="flex flex-col gap-1.5">
          <span class="text-muted text-xs font-semibold uppercase">最近完成</span>
          <div
            v-for="task in completedTasks.slice(0, 10)"
            :key="task.taskId"
            class="flex flex-col"
          >
            <!-- 概要行（有详情时可点击展开） -->
            <div
              class="flex items-center gap-2 px-1 py-1"
              :class="hasFileDetails(task) ? 'cursor-pointer hover:bg-elevated/50' : ''"
              @click="hasFileDetails(task) && toggleExpand(task.taskId)"
            >
              <NuxtIcon
                v-if="hasFileDetails(task)"
                :name="expandedTaskId === task.taskId ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                class="text-muted size-3.5 shrink-0"
              />
              <div v-else class="size-3.5 shrink-0" />
              <NuxtIcon
                :name="completedResultIcon(task).name"
                :class="completedResultIcon(task).class"
                class="size-4 shrink-0"
              />
              <NuxtIcon :name="typeIconMap[task.type]" class="text-muted size-3.5 shrink-0" />
              <span class="text-sm truncate flex-1">{{ task.description.label || typeLabelMap[task.type] }}</span>
              <span v-if="task.summary" class="text-muted shrink-0 text-xs">
                {{ task.summary.success }}/{{ task.summary.total }}
              </span>
              <NuxtBadge
                v-if="task.summary?.failed"
                color="error"
                variant="soft"
                size="sm"
                class="shrink-0"
              >
                {{ task.summary.failed }} 失败
              </NuxtBadge>
              <span class="text-muted shrink-0 text-xs">
                {{ relativeTime(task.completedAt ?? task.createdAt) }}
              </span>
            </div>
            <!-- 详情区（手风琴展开，max-h-60 overflow-y-auto） -->
            <div
              v-if="expandedTaskId === task.taskId"
              class="border-default max-h-60 overflow-y-auto border-t px-3 py-2"
            >
              <!-- dispatch: 实例维度 -->
              <template v-if="task.type === 'dispatch' && task.instanceProgress">
                <div
                  v-for="inst in task.instanceProgress"
                  :key="inst.instanceId"
                  class="flex flex-col gap-1 pb-2 last:pb-0"
                >
                  <div class="flex items-center gap-2">
                    <NuxtIcon name="i-lucide-server" class="text-muted size-3.5 shrink-0" />
                    <span class="text-xs font-medium truncate">{{ inst.instanceName }}</span>
                    <span class="text-muted shrink-0 font-mono text-xs">{{ inst.bucket }}</span>
                    <div class="flex-1" />
                    <span class="text-muted shrink-0 text-xs">{{ getInstanceStats(inst).done }}/{{ getInstanceStats(inst).total }}</span>
                    <NuxtBadge
                      v-if="getInstanceStats(inst).failed"
                      color="error"
                      variant="soft"
                      size="sm"
                    >
                      {{ getInstanceStats(inst).failed }} 失败
                    </NuxtBadge>
                  </div>
                  <div class="flex flex-col pl-5">
                    <div
                      v-for="(result, key) in inst.results"
                      :key="key"
                      class="flex items-center gap-2 py-0.5"
                    >
                      <NuxtIcon
                        :name="fileResultIcon(result).name"
                        :class="fileResultIcon(result).class"
                        class="size-3.5 shrink-0"
                      />
                      <span class="text-muted truncate flex-1 font-mono text-xs">{{ key }}</span>
                      <span v-if="result.status === 'success'" class="text-muted shrink-0 text-xs">{{ result.duration }}ms</span>
                      <NuxtTooltip v-else-if="result.status === 'failed'">
                        <span class="text-error shrink-0 text-xs">失败</span>
                        <template #content>{{ result.error }}</template>
                      </NuxtTooltip>
                      <span v-else class="text-muted shrink-0 text-xs">已跳过</span>
                    </div>
                  </div>
                </div>
              </template>
              <!-- 其他类型: 扁平文件维度 -->
              <template v-else-if="task.fileProgress">
                <div
                  v-for="(result, key) in task.fileProgress.results"
                  :key="key"
                  class="flex items-center gap-2 py-0.5"
                >
                  <NuxtIcon
                    :name="fileResultIcon(result).name"
                    :class="fileResultIcon(result).class"
                    class="size-3.5 shrink-0"
                  />
                  <span class="text-muted truncate flex-1 font-mono text-xs">{{ key }}</span>
                  <span v-if="result.status === 'success'" class="text-muted shrink-0 text-xs">{{ result.duration }}ms</span>
                  <NuxtTooltip v-else-if="result.status === 'failed'">
                    <span class="text-error shrink-0 text-xs">失败</span>
                    <template #content>{{ result.error }}</template>
                  </NuxtTooltip>
                  <span v-else class="text-muted shrink-0 text-xs">已跳过</span>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- ═══ 空状态 ═══ -->
        <div
          v-if="!activeTasks.length && !queueTasks.length && !completedTasks.length"
          class="text-muted text-center py-6 text-sm"
        >
          暂无任务
        </div>
      </div>
    </template>
  </NuxtPopover>
</template>
