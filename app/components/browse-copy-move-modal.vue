<script setup lang="ts">
/**
 * 复制/移动弹窗
 *
 * 三阶段：选择目标 -> 进度 -> 完成
 * 复制和移动共用同一套 UI，移动完成后增加删除源对象步骤。
 * 进度通过 SSE 实时推送。
 */

import type { InstanceGroup } from '#shared/schemas/groups'

interface CopyTarget {
  instanceId: string
  instanceName: string
  bucket: string
  prefix: string
}

interface ProgressItem {
  key: string
  name: string
  status: 'pending' | 'success' | 'failed'
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

type Phase = 'select' | 'scanning' | 'progress' | 'done'
const phase = ref<Phase>('select')

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

// ==================== 进度阶段 ====================

const totalObjects = ref(0)
const targetProgress = ref<TargetProgress[]>([])
const progressExpanded = ref<Record<string, boolean>>({})

const totalCompleted = computed(() =>
  targetProgress.value.reduce((sum, tp) => sum + tp.completed, 0),
)
const totalItems = computed(() => targetProgress.value.reduce((sum, tp) => sum + tp.total, 0))

// ==================== 执行（SSE） ====================

let eventSource: EventSource | null = null

async function startTransfer() {
  phase.value = 'scanning'
  totalObjects.value = 0
  targetProgress.value = []

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

  // 用 fetch + POST 发起 SSE（EventSource 只支持 GET，这里用 fetch 流式读取）
  try {
    const res = await fetch(`/api/browse/objects/${props.mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.statusMessage || `HTTP ${res.status}`)
    }

    // 初始化进度数据
    const target = validTargets.value[0]!
    targetProgress.value = [
      {
        target,
        items: [],
        completed: 0,
        total: 0,
        deletingSource: false,
      },
    ]
    progressExpanded.value[target.instanceId] = true
    phase.value = 'progress'

    // 读取 SSE 流
    const reader = res.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 解析 SSE 事件（以双换行分隔）
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''

      for (const evt of events) {
        const lines = evt.split('\n')
        let eventName = ''
        let eventData = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) eventName = line.slice(7)
          else if (line.startsWith('data: ')) eventData = line.slice(6)
        }
        if (!eventData) continue
        try {
          const data = JSON.parse(eventData)
          handleSSEEvent(eventName, data)
        } catch {
          // 忽略解析错误
        }
      }
    }

    // 流结束后，如果还没收到 done 事件，标记完成
    if (phase.value === 'progress') {
      finishTransfer()
    }
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

function handleSSEEvent(eventName: string, data: unknown) {
  const tp = targetProgress.value[0]
  if (!tp) return

  switch (eventName) {
    case 'total': {
      tp.total = (data as { total: number }).total
      totalObjects.value = tp.total
      // 预填充 pending 项（只填充 keys，prefixes 的文件由后端扫描）
      break
    }
    case 'progress': {
      const p = data as { key: string; status: string; error?: string }
      const item: ProgressItem = {
        key: p.key,
        name: p.key.split('/').pop() ?? p.key,
        status: p.status as 'success' | 'failed',
        error: p.error,
      }
      tp.items.push(item)
      if (p.status === 'success') tp.completed++
      break
    }
    case 'deleting': {
      tp.deletingSource = true
      break
    }
    case 'done': {
      const d = data as {
        success: number
        failed: number
        sourceDeleted?: number
        sourceDeleteFailed?: number
      }
      tp.completed = d.success
      tp.deletingSource = false
      finishTransfer(d)
      break
    }
    case 'error': {
      const d = data as { message: string }
      toast.add({ title: '错误', description: d.message, color: 'error' })
      phase.value = 'select'
      break
    }
  }
}

function finishTransfer(result?: { success: number; failed: number }) {
  phase.value = 'done'
  const tp = targetProgress.value[0]
  if (!tp) return
  const failed = result?.failed ?? tp.items.filter((i) => i.status === 'failed').length
  const success = result?.success ?? tp.items.filter((i) => i.status === 'success').length
  const actionLabel = props.mode === 'copy' ? '复制' : '移动'
  const isBackground = backgroundRunning.value
  if (failed > 0) {
    toast.add({
      title: `${actionLabel}完成：${success} 成功，${failed} 失败`,
      description: isBackground ? '点击查看详情' : undefined,
      color: 'warning',
      onClick: isBackground ? () => reopenFromBackground() : undefined,
    })
  } else {
    toast.add({
      title: `${actionLabel}完成：${success} 个对象`,
      description: isBackground ? '点击查看详情' : undefined,
      color: 'success',
      onClick: isBackground ? () => reopenFromBackground() : undefined,
    })
  }
}

function cancelTransfer() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  phase.value = 'select'
}

// ==================== 后台运行 ====================

const backgroundRunning = ref(false)
const reopeningFromBackground = ref(false)

function runInBackground() {
  backgroundRunning.value = true
  emit('update:open', false)
}

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

function onClose() {
  if (phase.value === 'done') {
    emit('complete')
  }
  phase.value = 'select'
  targetInstanceId.value = ''
  targetBucket.value = ''
  targetPrefix.value = ''
  targetProgress.value = []
  backgroundRunning.value = false
  emit('update:open', false)
}

watch(
  () => props.open,
  (open) => {
    if (open) {
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

const titleText = computed(() => (props.mode === 'copy' ? '复制到' : '移动到'))
const actionLabel = computed(() => (props.mode === 'copy' ? '开始复制' : '开始移动'))
const indicatorLabel = computed(() => (props.mode === 'copy' ? '复制中' : '移动中'))
</script>

<template>
  <div>
    <NuxtModal
      :open="open && !backgroundRunning"
      :title="titleText"
      :dismissible="phase !== 'scanning' && phase !== 'progress'"
      :ui="{ content: 'w-[calc(100vw-2rem)] max-w-2xl' }"
      @update:open="
        (v: boolean) => {
          if (!v && phase !== 'scanning' && phase !== 'progress') onClose()
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
                :items="targetBuckets.map((b) => ({ label: b, value: b }))"
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
        <div v-else-if="phase === 'scanning' || phase === 'progress'" class="flex flex-col gap-3">
          <div v-if="phase === 'scanning'" class="flex items-center gap-2 py-4">
            <NuxtIcon name="i-lucide-loader-circle" class="text-primary size-5 animate-spin" />
            <span class="text-sm">扫描中...</span>
          </div>

          <template v-else>
            <div class="text-muted text-sm">共 {{ totalObjects }} 个对象</div>

            <div class="flex items-center gap-2">
              <div class="bg-default h-2 flex-1 overflow-hidden rounded-full">
                <div
                  class="bg-primary h-full transition-all"
                  :style="{ width: `${totalItems > 0 ? (totalCompleted / totalItems) * 100 : 0}%` }"
                />
              </div>
              <span class="text-muted text-xs">{{ totalCompleted }}/{{ totalItems }}</span>
            </div>

            <div class="bg-elevated max-h-72 overflow-y-auto rounded-md p-2">
              <div v-for="tp in targetProgress" :key="tp.target.instanceId" class="mb-2">
                <button
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
                  @click="
                    progressExpanded[tp.target.instanceId] = !progressExpanded[tp.target.instanceId]
                  "
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
                  <span class="text-sm font-medium"
                    >{{ tp.target.instanceName }} / {{ tp.target.bucket }}</span
                  >
                  <span class="text-muted ml-auto text-xs">{{ tp.completed }}/{{ tp.total }}</span>
                </button>

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
                      v-else-if="item.status === 'failed'"
                      name="i-lucide-x"
                      class="text-error size-3.5 shrink-0"
                    />
                    <NuxtIcon v-else name="i-lucide-clock" class="text-muted size-3.5 shrink-0" />
                    <span class="truncate font-mono">{{ item.name }}</span>
                    <span
                      v-if="item.status === 'failed'"
                      class="text-error ml-auto truncate"
                      :title="item.error"
                      >{{ item.error }}</span
                    >
                  </div>
                </div>

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

        <!-- 完成阶段 -->
        <div v-else-if="phase === 'done'" class="flex flex-col gap-3">
          <div
            v-for="tp in targetProgress"
            :key="tp.target.instanceId"
            class="flex items-center gap-2"
          >
            <NuxtIcon name="i-lucide-check-circle" class="text-success size-5 shrink-0" />
            <span class="text-sm">
              {{ tp.target.instanceName }} / {{ tp.target.bucket }}
              <span class="text-muted">
                {{ tp.completed - tp.items.filter((i) => i.status === 'failed').length }}/{{
                  tp.total
                }}
                成功
              </span>
              <span
                v-if="tp.items.filter((i) => i.status === 'failed').length > 0"
                class="text-error"
              >
                ，{{ tp.items.filter((i) => i.status === 'failed').length }} 失败
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
          <template v-else-if="phase === 'scanning' || phase === 'progress'">
            <NuxtButton
              v-if="phase === 'progress'"
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-down-to-line"
              label="后台运行"
              @click="runInBackground"
            />
            <NuxtButton color="neutral" variant="ghost" label="取消" @click="cancelTransfer" />
          </template>
          <template v-else-if="phase === 'done'">
            <NuxtButton color="primary" label="关闭" @click="onClose" />
          </template>
        </div>
      </template>
    </NuxtModal>

    <!-- 后台运行悬浮指示器 -->
    <div
      v-if="backgroundRunning && (phase === 'progress' || phase === 'done')"
      class="fixed right-4 bottom-4 z-50"
    >
      <button
        class="bg-default border-default hover:border-primary flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg transition-colors"
        @click="reopenFromBackground"
      >
        <NuxtIcon
          v-if="phase !== 'done'"
          name="i-lucide-loader-circle"
          class="text-primary size-5 animate-spin"
        />
        <NuxtIcon v-else name="i-lucide-check-circle" class="text-success size-5" />
        <div class="text-left">
          <div class="text-sm font-medium">
            {{
              phase === 'done' ? (mode === 'copy' ? '复制完成' : '移动完成') : `${indicatorLabel}`
            }}
          </div>
          <div v-if="phase !== 'done'" class="text-muted text-xs">
            {{ totalCompleted }}/{{ totalItems }}
          </div>
        </div>
      </button>
    </div>
  </div>
</template>
