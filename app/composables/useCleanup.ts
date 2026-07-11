/**
 * 批量清理相关前端逻辑
 *
 * 状态管理：选中实例、bucket 交集加载、前缀过滤、递归开关、
 * 预览对象列表（多选）、SSE 进度聚合视图、运行状态。
 *
 * 结构与 useDispatch.ts 对称。
 */

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
interface ListObjectsResult {
  objects: ObjectInfo[]
  commonPrefixes: string[]
  isTruncated: boolean
  continuationToken?: string
  error?: string
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

/** 单元格状态 */
type CellStatus = CleanupResult | 'running' | null

/** 实例 bucket 加载状态 */
interface BucketLoadState {
  buckets: string[]
  loading: boolean
  error?: string
}

export function useCleanup() {
  // ---------- 选中的实例 / bucket / 前缀 ----------
  const selectedInstanceIds = ref<Set<string>>(new Set())
  const selectedBucket = ref<string>('')
  const prefix = ref<string>('')
  const recursive = ref<boolean>(true)

  // ---------- 预览状态 ----------
  const previewObjects = ref<ObjectInfo[]>([])
  const previewPrefixes = ref<string[]>([])
  const previewContinuationToken = ref<string | undefined>(undefined)
  const previewLoading = ref(false)
  const previewError = ref<string>('')
  const previewReferenceInstanceId = ref<string>('')

  // 预览多选
  const selectedKeys = ref<Set<string>>(new Set())
  const selectedPrefixes = ref<Set<string>>(new Set())

  // ---------- bucket 加载（复用 useDispatch 的 loadBuckets 思路）----------
  const instanceBucketOptions = ref<Record<string, BucketLoadState>>({})

  // ---------- 进度 ----------
  const progress = ref<Record<string, CellStatus>>({})
  const isRunning = ref(false)
  const taskSummary = ref<{ total: number; success: number; failed: number } | null>(null)
  let eventSource: EventSource | null = null

  // ---------- 辅助函数 ----------

  function cellKey(instanceId: string, target: string): string {
    return `${instanceId}::${target}`
  }

  function getCell(instanceId: string, target: string): CellStatus {
    return progress.value[cellKey(instanceId, target)] ?? null
  }

  function getSelectedInstances(groups: InstanceGroup[]): MinioInstance[] {
    const result: MinioInstance[] = []
    const seen = new Set<string>()
    for (const g of groups) {
      for (const inst of g.instances) {
        if (selectedInstanceIds.value.has(inst.id) && inst.enabled && !seen.has(inst.id)) {
          result.push(inst)
          seen.add(inst.id)
        }
      }
    }
    return result
  }

  // ---------- Bucket 管理 ----------

  /** 获取实例当前加载的 bucket 列表状态 */
  function getInstanceBucketOptions(inst: MinioInstance): BucketLoadState {
    return instanceBucketOptions.value[inst.id] ?? { buckets: [], loading: false }
  }

  /**
   * 异步加载选中实例的 bucket 列表（从 MinIO ListBuckets 拉取）。
   * 只加载尚未加载过的实例。
   */
  async function loadBuckets(groups: InstanceGroup[]) {
    const selected = getSelectedInstances(groups)
    const needLoad = selected.filter(inst => !instanceBucketOptions.value[inst.id])
    if (!needLoad.length) return

    // 标记为 loading
    for (const inst of needLoad) {
      instanceBucketOptions.value[inst.id] = { buckets: [], loading: true }
    }

    try {
      const result = await $fetch<Record<string, { buckets: string[], error?: string }>>('/api/instances/buckets', {
        method: 'POST',
        body: { instanceIds: needLoad.map(i => i.id) },
      })

      for (const inst of needLoad) {
        const r = result[inst.id]
        if (r) {
          instanceBucketOptions.value[inst.id] = {
            buckets: r.buckets,
            loading: false,
            error: r.error,
          }
        }
      }
    }
    catch (e: any) {
      // 整体请求失败，标记所有为 error
      for (const inst of needLoad) {
        instanceBucketOptions.value[inst.id] = {
          buckets: [],
          loading: false,
          error: e?.data?.statusMessage || e?.message || '请求失败',
        }
      }
    }
  }

  /**
   * 计算所有选中实例的 bucket 交集（用于全局 bucket 下拉候选）。
   * 只统计已加载完成（非 loading）的实例；任一实例加载失败则该实例跳过交集计算。
   */
  function getBucketIntersection(groups: InstanceGroup[]): string[] {
    const selected = getSelectedInstances(groups)
    if (!selected.length) return []

    const readySets: Set<string>[] = []
    for (const inst of selected) {
      const opts = instanceBucketOptions.value[inst.id]
      // 跳过 loading 中和加载失败的实例
      if (opts && !opts.loading && !opts.error) {
        readySets.push(new Set(opts.buckets))
      }
    }
    if (!readySets.length) return []

    // 交集
    let intersection = readySets[0]!
    for (let i = 1; i < readySets.length; i++) {
      intersection = new Set([...intersection].filter(x => readySets[i]!.has(x)))
    }
    return [...intersection].sort()
  }

  /** 检查选中实例中是否有 bucket 加载失败的 */
  function hasBucketLoadError(groups: InstanceGroup[]): boolean {
    const selected = getSelectedInstances(groups)
    return selected.some(inst => instanceBucketOptions.value[inst.id]?.error)
  }

  // ---------- 预览 ----------

  /** 加载预览对象列表（以指定实例为参考） */
  async function loadPreview(instanceId: string, token?: string) {
    if (!instanceId || !selectedBucket.value) return

    if (token) {
      previewLoading.value = true
    }
    else {
      previewLoading.value = true
      previewObjects.value = []
      previewPrefixes.value = []
      previewContinuationToken.value = undefined
      selectedKeys.value = new Set()
      selectedPrefixes.value = new Set()
    }
    previewError.value = ''
    previewReferenceInstanceId.value = instanceId

    try {
      const res = await $fetch<ListObjectsResult>('/api/instances/objects/list', {
        method: 'POST',
        body: {
          instanceId,
          bucket: selectedBucket.value,
          prefix: prefix.value,
          continuationToken: token,
        },
      })

      if (res.error) {
        previewError.value = res.error
        return
      }

      if (token) {
        previewObjects.value.push(...res.objects)
        previewPrefixes.value.push(...res.commonPrefixes)
      }
      else {
        previewObjects.value = res.objects
        previewPrefixes.value = res.commonPrefixes
      }
      previewContinuationToken.value = res.isTruncated ? res.continuationToken : undefined
    }
    catch (e: any) {
      previewError.value = e?.data?.statusMessage || e?.message || '加载失败'
    }
    finally {
      previewLoading.value = false
    }
  }

  // ---------- 预览多选 ----------

  function toggleSelectKey(key: string) {
    const set = new Set(selectedKeys.value)
    set.has(key) ? set.delete(key) : set.add(key)
    selectedKeys.value = set
  }

  function toggleSelectPrefix(pfx: string) {
    const set = new Set(selectedPrefixes.value)
    set.has(pfx) ? set.delete(pfx) : set.add(pfx)
    selectedPrefixes.value = set
  }

  /** 当前预览页全部可选项 */
  const allSelectable = computed(() => [
    ...previewPrefixes.value,
    ...previewObjects.value.map(o => o.key),
  ])
  const selectedCount = computed(() => selectedKeys.value.size + selectedPrefixes.value.size)
  const isAllSelected = computed(() =>
    allSelectable.value.length > 0 && allSelectable.value.every(k => selectedKeys.value.has(k) || selectedPrefixes.value.has(k)),
  )
  const isPartialSelected = computed(() =>
    allSelectable.value.some(k => selectedKeys.value.has(k) || selectedPrefixes.value.has(k)) && !isAllSelected.value,
  )

  function toggleSelectAll() {
    const keySet = new Set(selectedKeys.value)
    const prefixSet = new Set(selectedPrefixes.value)
    if (isAllSelected.value) {
      for (const cp of previewPrefixes.value) prefixSet.delete(cp)
      for (const o of previewObjects.value) keySet.delete(o.key)
    }
    else {
      for (const cp of previewPrefixes.value) prefixSet.add(cp)
      for (const o of previewObjects.value) keySet.add(o.key)
    }
    selectedKeys.value = keySet
    selectedPrefixes.value = prefixSet
  }

  // ---------- 提交清理 ----------

  /** 提交清理任务 */
  async function submit(groups: InstanceGroup[]) {
    if (isRunning.value) return

    const toast = useToast()

    const selected = getSelectedInstances(groups)
    if (!selected.length) {
      toast.add({ title: '请先选择目标实例', color: 'warning' })
      return
    }
    if (!selectedBucket.value) {
      toast.add({ title: '请先选择 bucket', color: 'warning' })
      return
    }

    // 构建请求体
    const body: {
      instanceIds: string[]
      bucket: string
      prefix?: string
      recursive?: boolean
      keys?: string[]
      prefixes?: string[]
    } = {
      instanceIds: selected.map(i => i.id),
      bucket: selectedBucket.value,
      prefix: prefix.value || undefined,
      recursive: recursive.value,
    }

    // 精确模式：带 keys + prefixes
    const hasKeys = selectedKeys.value.size > 0
    const hasPrefixes = selectedPrefixes.value.size > 0
    if (hasKeys || hasPrefixes) {
      body.keys = hasKeys ? Array.from(selectedKeys.value) : undefined
      body.prefixes = hasPrefixes ? Array.from(selectedPrefixes.value) : undefined
    }

    progress.value = {}
    taskSummary.value = null
    isRunning.value = true

    try {
      const res = await $fetch<{ taskId: string }>('/api/cleanup', {
        method: 'POST',
        body,
      })

      eventSource = new EventSource(`/api/cleanup/events?taskId=${res.taskId}`)

      // 计算所有目标列表（用于 start 时标记 running）
      const targets: string[] = []
      if (body.keys) targets.push(...body.keys)
      if (body.prefixes) targets.push(...body.prefixes)
      // 按前缀全删模式：target 为 prefix 或 '/'
      if (!targets.length) targets.push(body.prefix || '/')

      eventSource.addEventListener('start', () => {
        for (const inst of selected) {
          for (const t of targets) {
            progress.value[cellKey(inst.id, t)] = 'running'
          }
        }
      })

      eventSource.addEventListener('progress', (e: MessageEvent) => {
        const data = JSON.parse(e.data)
        if (data.result) {
          progress.value[cellKey(data.result.instanceId, data.result.target)] = data.result
        }
      })

      eventSource.addEventListener('complete', (e: MessageEvent) => {
        const data = JSON.parse(e.data)
        taskSummary.value = data.summary
        isRunning.value = false

        // 将仍为 running 的标记为 failed（未收到结果）
        for (const inst of selected) {
          for (const t of targets) {
            const k = cellKey(inst.id, t)
            if (progress.value[k] === 'running') {
              progress.value[k] = {
                instanceId: inst.id,
                instanceName: inst.name,
                target: t,
                targetType: t.endsWith('/') ? 'prefix' : 'object',
                status: 'failed',
                error: '未收到结果',
              }
            }
          }
        }

        eventSource?.close()
        eventSource = null

        const s = data.summary
        toast.add({
          title: '清理完成',
          description: `共 ${s.total} 个操作，成功 ${s.success}，失败 ${s.failed}`,
          color: s.failed > 0 ? 'warning' : 'success',
        })
      })

      eventSource.onerror = () => {
        if (isRunning.value) {
          isRunning.value = false
          toast.add({ title: '连接中断', description: 'SSE 连接异常，进度可能不完整', color: 'error' })
        }
        eventSource?.close()
        eventSource = null
      }
    }
    catch (e: any) {
      isRunning.value = false
      toast.add({ title: '清理失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
    }
  }

  function cancel() {
    eventSource?.close()
    eventSource = null
    isRunning.value = false
  }

  /** 实例级聚合进度 */
  function getInstanceProgress(instanceId: string, targets: string[]): { completed: number; total: number; failed: number } {
    let completed = 0
    let failed = 0
    for (const t of targets) {
      const cell = progress.value[cellKey(instanceId, t)]
      if (cell && cell !== 'running') {
        completed++
        if (typeof cell === 'object' && cell.status === 'failed') failed++
      }
    }
    return { completed, total: targets.length, failed }
  }

  return {
    selectedInstanceIds,
    selectedBucket,
    prefix,
    recursive,
    previewObjects,
    previewPrefixes,
    previewContinuationToken,
    previewLoading,
    previewError,
    previewReferenceInstanceId,
    selectedKeys,
    selectedPrefixes,
    instanceBucketOptions,
    progress,
    isRunning,
    taskSummary,
    allSelectable,
    selectedCount,
    isAllSelected,
    isPartialSelected,
    cellKey,
    getCell,
    getSelectedInstances,
    getInstanceBucketOptions,
    loadBuckets,
    getBucketIntersection,
    hasBucketLoadError,
    loadPreview,
    toggleSelectKey,
    toggleSelectPrefix,
    toggleSelectAll,
    submit,
    cancel,
    getInstanceProgress,
  }
}
