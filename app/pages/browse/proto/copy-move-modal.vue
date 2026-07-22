<script setup lang="ts">
/**
 * 复制/移动弹窗原型
 *
 * 三阶段：选择目标 -> 进度 -> 完成
 * 复制：多目标（多实例多 bucket）
 * 移动：单目标（单实例单 bucket），完成后删除源对象
 *
 * 原型不对接真实 API，用 setTimeout 模拟扫描和传输进度。
 */

import type { MockGroup } from './mock-data'

interface CopyTarget {
  instanceId: string
  instanceName: string
  bucket: string
  prefix: string
}

interface ProgressItem {
  key: string
  name: string
  size: number
  status: 'pending' | 'uploading' | 'success' | 'failed'
  progress: number
  error?: string
}

interface TargetProgress {
  target: CopyTarget
  items: ProgressItem[]
  completed: number
  total: number
  deletingSource: boolean
}

const props = defineProps<{
  open: boolean
  mode: 'copy' | 'move'
  groups: MockGroup[]
  sourceInstanceId: string
  sourceInstanceName: string
  sourceBucket: string
  sourcePrefix: string
  selectedKeys: Set<string>
  selectedPrefixes: Set<string>
  /** 单行操作时传入的目标，优先于 selectedKeys/selectedPrefixes */
  singleTarget?: { type: 'object' | 'folder'; key: string } | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  complete: []
}>()

const toast = useToast()

type Phase = 'select' | 'scanning' | 'progress' | 'done'
const phase = ref<Phase>('select')

// ==================== 选择阶段：单目标选择（复制/移动共用） ====================

const targetInstanceId = ref<string>('')
const targetBucket = ref<string>('')
const targetPrefix = ref<string>('')

/** 有效选中的 keys 和 prefixes（单行操作时优先用 singleTarget） */
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

const sourceSelectedCount = computed(
  () => effectiveKeys.value.size + effectivePrefixes.value.size,
)

/** 所有 enabled 实例（扁平） */
const enabledInstances = computed(() =>
  props.groups.flatMap((g) => g.instances.filter((i) => i.enabled)),
)

/** 有效目标（有 bucket 的） */
const validTargets = computed<CopyTarget[]>(() => {
  if (!targetInstanceId.value || !targetBucket.value) return []
  return [
    {
      instanceId: targetInstanceId.value,
      instanceName:
        enabledInstances.value.find((i) => i.id === targetInstanceId.value)?.name ?? '',
      bucket: targetBucket.value,
      prefix: targetPrefix.value.trim(),
    },
  ]
})

const canSubmit = computed(
  () => sourceSelectedCount.value > 0 && validTargets.value.length > 0,
)

// 模拟 bucket 列表
const mockBuckets = ['logs', 'backups', 'configs', 'media', 'data', 'temp', 'archive']

function getInstanceBuckets(instanceId: string): string[] {
  if (instanceId === props.sourceInstanceId) {
    return mockBuckets
  }
  return mockBuckets
}

function isSourceInstance(instanceId: string): boolean {
  return instanceId === props.sourceInstanceId
}

// ==================== 进度阶段 ====================

const scannedCount = ref(0)
const totalObjects = ref(0)
const totalSize = ref(0)
const targetProgress = ref<TargetProgress[]>([])
const progressExpanded = ref<Record<string, boolean>>({})

const totalCompleted = computed(() =>
  targetProgress.value.reduce((sum, tp) => sum + tp.completed, 0),
)
const totalItems = computed(() =>
  targetProgress.value.reduce((sum, tp) => sum + tp.total, 0),
)
const allDone = computed(
  () => phase.value === 'done' || (targetProgress.value.length > 0 && targetProgress.value.every((tp) => tp.completed >= tp.total)),
)

// ==================== 执行 ====================

let cancelled = false

async function startTransfer() {
  phase.value = 'scanning'
  scannedCount.value = 0
  totalObjects.value = 0
  totalSize.value = 0
  targetProgress.value = []
  cancelled = false

  // 模拟扫描
  const scanTotal = Math.floor(Math.random() * 10) + 5
  for (let i = 0; i < scanTotal; i++) {
    if (cancelled) return
    await delay(200)
    scannedCount.value = i + 1
  }
  totalObjects.value = scanTotal
  totalSize.value = Math.floor(Math.random() * 5_000_000) + 500_000

  // 超限检查（模拟 10000 上限）
  if (scanTotal > 10000) {
    toast.add({
      title: `源对象超过 10000 个上限（${scanTotal} 个），请缩小范围`,
      color: 'error',
    })
    phase.value = 'select'
    return
  }

  // 构建进度数据
  const sourceItems = Array.from(effectiveKeys.value)
  const sourceFolders = Array.from(effectivePrefixes.value)

  // 生成模拟文件列表
  const mockFiles: { key: string; name: string; size: number }[] = []
  for (const key of sourceItems) {
    mockFiles.push({
      key,
      name: key.split('/').pop() ?? key,
      size: Math.floor(Math.random() * 500_000) + 1000,
    })
  }
  for (const f of sourceFolders) {
    // 文件夹展开几个文件
    for (let i = 0; i < 3; i++) {
      mockFiles.push({
        key: `${f}file-${i + 1}.json`,
        name: `file-${i + 1}.json`,
        size: Math.floor(Math.random() * 100_000) + 500,
      })
    }
  }
  // 如果没有选中项，用几个 mock 文件
  if (mockFiles.length === 0) {
    for (let i = 0; i < scanTotal; i++) {
      mockFiles.push({
        key: `file-${i + 1}.dat`,
        name: `file-${i + 1}.dat`,
        size: Math.floor(Math.random() * 200_000) + 1000,
      })
    }
  }

  // 真实文件数取扫描数和 mock 文件数的较大值
  const fileCount = Math.max(mockFiles.length, scanTotal)
  while (mockFiles.length < fileCount) {
    mockFiles.push({
      key: `extra-${mockFiles.length + 1}.dat`,
      name: `extra-${mockFiles.length + 1}.dat`,
      size: Math.floor(Math.random() * 200_000) + 1000,
    })
  }

  // 为每个目标构建进度
  targetProgress.value = validTargets.value.map((target) => ({
    target,
    items: mockFiles.map((f) => ({
      key: f.key,
      name: f.name,
      size: f.size,
      status: 'pending' as const,
      progress: 0,
    })),
    completed: 0,
    total: fileCount,
    deletingSource: false,
  }))

  // 默认展开
  for (const tp of targetProgress.value) {
    progressExpanded.value[tp.target.instanceId] = true
  }

  phase.value = 'progress'

  // 逐实例串行，实例内文件串行
  for (const tp of targetProgress.value) {
    if (cancelled) return
    for (const item of tp.items) {
      if (cancelled) return
      item.status = 'uploading'
      await simulateTransfer(item)
      // 10% 失败率
      if (Math.random() < 0.1) {
        item.status = 'failed'
        item.error = '超时'
      } else {
        item.status = 'success'
        item.progress = 100
      }
      tp.completed++
    }
  }

  // 移动模式：删除源对象
  if (props.mode === 'move' && !cancelled) {
    if (targetProgress.value[0]) {
      targetProgress.value[0]!.deletingSource = true
      await delay(800)
      targetProgress.value[0]!.deletingSource = false
    }
  }

  if (!cancelled) {
    phase.value = 'done'
    const failed = targetProgress.value.reduce(
      (sum, tp) => sum + tp.items.filter((i) => i.status === 'failed').length,
      0,
    )
    const actionLabel = props.mode === 'copy' ? '复制' : '移动'
    const isBackground = backgroundRunning.value
    const toastClickAction = isBackground
      ? () => reopenFromBackground()
      : undefined
    if (failed > 0) {
      toast.add({
        title: `${actionLabel}完成：${totalCompleted.value - failed} 成功，${failed} 失败`,
        description: isBackground ? '点击查看详情' : undefined,
        color: 'warning',
        onClick: toastClickAction,
      })
    } else {
      toast.add({
        title: `${actionLabel}完成：${totalCompleted.value} 个对象`,
        description: isBackground ? '点击查看详情' : undefined,
        color: 'success',
        onClick: toastClickAction,
      })
    }
  }
}

function simulateTransfer(item: ProgressItem): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      item.progress += Math.random() * 25
      if (item.progress >= 100) {
        item.progress = 100
        clearInterval(interval)
        resolve()
      }
    }, 100)
  })
}

function cancelTransfer() {
  cancelled = true
  phase.value = 'select'
}

// ==================== 后台运行 ====================

const backgroundRunning = ref(false)

function runInBackground() {
  backgroundRunning.value = true
  emit('update:open', false)
}

/** 从后台运行重新打开弹窗 */
const reopeningFromBackground = ref(false)

function reopenFromBackground() {
  reopeningFromBackground.value = true
  backgroundRunning.value = false
  emit('update:open', true)
}

// ==================== 完成/关闭 ====================

const failedItems = computed(() => {
  const items: { target: string; name: string; error: string }[] = []
  for (const tp of targetProgress.value) {
    for (const item of tp.items) {
      if (item.status === 'failed') {
        items.push({
          target: `${tp.target.instanceName} / ${tp.target.bucket}`,
          name: item.name,
          error: item.error ?? '未知错误',
        })
      }
    }
  }
  return items
})

function retryFailed() {
  for (const tp of targetProgress.value) {
    for (const item of tp.items) {
      if (item.status === 'failed') {
        item.status = 'pending'
        item.progress = 0
        item.error = undefined
        tp.completed--
      }
    }
  }
  phase.value = 'progress'
  // 重新执行失败的
  retryFailedItems()
}

async function retryFailedItems() {
  for (const tp of targetProgress.value) {
    for (const item of tp.items) {
      if (item.status === 'pending') {
        item.status = 'uploading'
        await simulateTransfer(item)
        if (Math.random() < 0.1) {
          item.status = 'failed'
          item.error = '超时'
        } else {
          item.status = 'success'
          item.progress = 100
        }
        tp.completed++
      }
    }
  }
  phase.value = 'done'
}

function onClose() {
  if (phase.value === 'done') {
    emit('complete')
  }
  // 重置
  phase.value = 'select'
  targetInstanceId.value = ''
  targetBucket.value = ''
  targetPrefix.value = ''
  targetProgress.value = []
  backgroundRunning.value = false
  emit('update:open', false)
}

// ==================== 重置 ====================

watch(
  () => props.open,
  (open) => {
    if (open) {
      // 后台恢复时不重置状态，保留任务进度
      if (reopeningFromBackground.value) {
        reopeningFromBackground.value = false
        return
      }
      phase.value = 'select'
      targetInstanceId.value = ''
      targetBucket.value = ''
      targetPrefix.value = ''
      targetProgress.value = []
    }
  },
)

// ==================== 辅助 ====================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const titleText = computed(() =>
  props.mode === 'copy' ? '复制到' : '移动到',
)
const actionLabel = computed(() =>
  props.mode === 'copy' ? '开始复制' : '开始移动',
)
const indicatorLabel = computed(() =>
  props.mode === 'copy' ? '复制中' : '移动中',
)
</script>

<template>
  <div>
    <!-- ==================== 主弹窗 ==================== -->
    <NuxtModal
      :open="open && !backgroundRunning"
      :dismissible="phase !== 'scanning' && phase !== 'progress'"
      :ui="{ content: 'w-[calc(100vw-2rem)] max-w-2xl' }"
      @update:open="(v: boolean) => { if (!v && phase !== 'scanning' && phase !== 'progress') onClose() }"
    >
      <template #header>
        <div class="flex items-center gap-2">
          <NuxtIcon
            :name="mode === 'copy' ? 'i-lucide-copy' : 'i-lucide-folder-input'"
            class="text-primary size-5"
          />
          <span class="text-highlighted font-semibold">{{ titleText }}</span>
        </div>
      </template>

      <template #body>
        <!-- ==================== 阶段一：选择目标 ==================== -->
        <div v-if="phase === 'select'" class="flex flex-col gap-4">
          <!-- 源信息 -->
          <div class="bg-elevated rounded-md p-3">
            <div class="text-muted text-xs">源</div>
            <div class="text-highlighted mt-1 font-mono text-sm">
              {{ sourceInstanceName }} / {{ sourceBucket }} / {{ sourcePrefix || '(根目录)' }}
            </div>
            <div class="text-muted mt-1 text-xs">
              已选：{{ effectiveKeys.size }} 个对象，{{ effectivePrefixes.size }} 个文件夹
            </div>
          </div>

          <!-- 单目标选择（复制/移动共用） -->
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
                    >源实例</NuxtBadge>
                  </span>
                  <span v-else class="text-muted">选择实例</span>
                </template>
              </NuxtSelectMenu>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-muted w-24 shrink-0 text-sm">目标 Bucket：</span>
              <NuxtSelectMenu
                v-model="targetBucket"
                :items="targetInstanceId ? getInstanceBuckets(targetInstanceId).map((b) => ({ label: b, value: b, disabled: isSourceInstance(targetInstanceId) && b === sourceBucket })) : []"
                value-key="value"
                placeholder="选择 bucket"
                :disabled="!targetInstanceId"
                class="flex-1"
              >
                <template #default>
                  <span v-if="targetBucket" class="font-mono text-sm">
                    {{ targetBucket }}
                    <span
                      v-if="isSourceInstance(targetInstanceId) && targetBucket === sourceBucket"
                      class="text-warning"
                    >（源 bucket）</span>
                  </span>
                  <span v-else class="text-muted">选择 bucket</span>
                </template>
              </NuxtSelectMenu>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-muted w-24 shrink-0 text-sm">目标前缀：</span>
              <NuxtInput
                v-model="targetPrefix"
                placeholder="留空 = bucket 根"
                class="flex-1"
              />
            </div>
            <div v-if="mode === 'move'" class="bg-warning/10 flex items-center gap-2 rounded-md p-3 text-warning">
              <NuxtIcon name="i-lucide-triangle-alert" class="size-4 shrink-0" />
              <span class="text-sm">移动 = 复制到目标 + 删除源对象</span>
            </div>
            <div class="text-muted text-xs">
              约束：源实例作为目标时，bucket 必须不同于 {{ sourceBucket }}
            </div>
          </div>
        </div>

        <!-- ==================== 阶段二：进度 ==================== -->
        <div v-else-if="phase === 'scanning' || phase === 'progress'" class="flex flex-col gap-3">
          <!-- 扫描中 -->
          <div v-if="phase === 'scanning'" class="flex items-center gap-2 py-4">
            <NuxtIcon name="i-lucide-loader-circle" class="text-primary size-5 animate-spin" />
            <span class="text-sm">扫描中... 已发现 {{ scannedCount }} 个对象</span>
          </div>

          <!-- 传输进度 -->
          <template v-else>
            <div class="text-muted text-sm">
              共 {{ totalObjects }} 个对象，总计 {{ formatSize(totalSize) }}
            </div>

            <!-- 总进度 -->
            <div class="flex items-center gap-2">
              <div class="bg-default h-2 flex-1 overflow-hidden rounded-full">
                <div
                  class="bg-primary h-full transition-all"
                  :style="{ width: `${totalItems > 0 ? (totalCompleted / totalItems) * 100 : 0}%` }"
                />
              </div>
              <span class="text-muted text-xs">{{ totalCompleted }}/{{ totalItems }}</span>
            </div>

            <!-- 每个目标的进度 -->
            <div class="bg-elevated max-h-72 overflow-y-auto rounded-md p-2">
              <div v-for="tp in targetProgress" :key="tp.target.instanceId" class="mb-2">
                <!-- 目标头 -->
                <button
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
                  @click="progressExpanded[tp.target.instanceId] = !progressExpanded[tp.target.instanceId]"
                >
                  <NuxtIcon
                    :name="
                      progressExpanded[tp.target.instanceId]
                        ? 'i-lucide-chevron-down'
                        : 'i-lucide-chevron-right'
                    "
                    class="text-muted size-4"
                  />
                  <NuxtIcon name="i-lucide-server" class="text-muted size-4" />
                  <span class="text-sm font-medium">{{ tp.target.instanceName }} / {{ tp.target.bucket }}</span>
                  <span class="text-muted ml-auto text-xs">{{ tp.completed }}/{{ tp.total }}</span>
                </button>

                <!-- 文件列表 -->
                <div v-show="progressExpanded[tp.target.instanceId]" class="ml-6">
                  <div
                    v-for="item in tp.items"
                    :key="item.key"
                    class="flex items-center gap-2 py-1 text-xs"
                  >
                    <NuxtIcon
                      v-if="item.status === 'success'"
                      name="i-lucide-check"
                      class="text-success size-3.5 shrink-0"
                    />
                    <NuxtIcon
                      v-else-if="item.status === 'uploading'"
                      name="i-lucide-arrow-up"
                      class="text-primary size-3.5 shrink-0"
                    />
                    <NuxtIcon
                      v-else-if="item.status === 'failed'"
                      name="i-lucide-x"
                      class="text-error size-3.5 shrink-0"
                    />
                    <NuxtIcon
                      v-else
                      name="i-lucide-clock"
                      class="text-muted size-3.5 shrink-0"
                    />
                    <span class="truncate font-mono">{{ item.name }}</span>
                    <span class="text-muted shrink-0">{{ formatSize(item.size) }}</span>
                    <span v-if="item.status === 'uploading'" class="text-primary ml-auto">
                      {{ Math.floor(item.progress) }}%
                    </span>
                    <span v-else-if="item.status === 'failed'" class="text-error ml-auto truncate" :title="item.error">
                      {{ item.error }}
                    </span>
                  </div>
                </div>

                <!-- 删除源提示（移动模式） -->
                <div
                  v-if="tp.deletingSource"
                  class="text-warning ml-6 flex items-center gap-1 py-1 text-xs"
                >
                  <NuxtIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
                  <span>复制完成，正在删除源对象...</span>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- ==================== 阶段三：完成 ==================== -->
        <div v-else-if="phase === 'done'" class="flex flex-col gap-3">
          <div v-for="tp in targetProgress" :key="tp.target.instanceId" class="flex items-center gap-2">
            <NuxtIcon name="i-lucide-check-circle" class="text-success size-5 shrink-0" />
            <span class="text-sm">
              {{ tp.target.instanceName }} / {{ tp.target.bucket }}
              <span class="text-muted">
                {{ tp.completed - tp.items.filter((i) => i.status === 'failed').length }}/{{ tp.total }} 成功
              </span>
              <span
                v-if="tp.items.filter((i) => i.status === 'failed').length > 0"
                class="text-error"
              >
                ，{{ tp.items.filter((i) => i.status === 'failed').length }} 失败
              </span>
            </span>
          </div>

          <!-- 失败项 -->
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
          <!-- 选择阶段 -->
          <template v-if="phase === 'select'">
            <NuxtButton
              color="neutral"
              variant="ghost"
              label="取消"
              @click="onClose"
            />
            <NuxtButton
              color="primary"
              :icon="mode === 'copy' ? 'i-lucide-copy' : 'i-lucide-folder-input'"
              :label="actionLabel"
              :disabled="!canSubmit"
              @click="startTransfer"
            />
          </template>

          <!-- 进度阶段 -->
          <template v-else-if="phase === 'scanning' || phase === 'progress'">
            <NuxtButton
              v-if="phase === 'progress'"
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-down-to-line"
              label="后台运行"
              @click="runInBackground"
            />
            <NuxtButton
              color="neutral"
              variant="ghost"
              label="取消"
              @click="cancelTransfer"
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
            <NuxtButton
              color="primary"
              label="关闭"
              @click="onClose"
            />
          </template>
        </div>
      </template>
    </NuxtModal>

    <!-- ==================== 后台运行悬浮指示器 ==================== -->
    <div
      v-if="backgroundRunning && (phase === 'progress' || phase === 'done')"
      class="fixed bottom-4 right-4 z-50"
    >
      <button
        class="bg-default border-default flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg transition-colors hover:border-primary"
        @click="reopenFromBackground"
      >
        <NuxtIcon
          v-if="phase !== 'done'"
          name="i-lucide-loader-circle"
          class="text-primary size-5 animate-spin"
        />
        <NuxtIcon
          v-else
          name="i-lucide-check-circle"
          class="text-success size-5"
        />
        <div class="text-left">
          <div class="text-sm font-medium">
            {{ phase === 'done' ? (mode === 'copy' ? '复制完成' : '移动完成') : `${indicatorLabel}` }}
          </div>
          <div v-if="phase !== 'done'" class="text-muted text-xs">
            {{ totalCompleted }}/{{ totalItems }}
          </div>
        </div>
      </button>
    </div>
  </div>
</template>
