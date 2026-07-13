interface MinioInstance {
  id: string
  groupId: string
  name: string
  endpoint: string
  accessKey: string
  secretKey: string
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

interface SyncResult {
  instanceId: string
  instanceName: string
  fileName: string
  status: 'success' | 'failed'
  error?: string
  duration?: number
}

interface SyncFileInfo {
  key: string
  relativeKey: string
  size: number
  contentType: string
}

interface SyncSource {
  instanceId: string
  bucket: string
  prefix: string
  keys: string[]
  prefixes: string[]
}

type CellStatus = SyncResult | 'running' | null

interface BucketLoadState {
  buckets: string[]
  loading: boolean
  error?: string
}

/**
 * 实例间同步前端逻辑
 *
 * 在 browser 页实例化，通过 props 传入 SyncTargetModal。
 * 管理：目标端选择状态 + 同步进度 + SSE 订阅 + Modal 阶段。
 * 不包含源端选择（源由 browser 页提供）。
 */
export function useSync() {
  // ── 目标端状态 ───────────────────────────────────────────
  const targetInstanceIds = ref<Set<string>>(new Set())
  const targetBuckets = ref<Record<string, string>>({})
  const targetBucketOptions = ref<Record<string, BucketLoadState>>({})
  const targetPrefix = ref<string>('')

  // ── toast（必须在 setup 阶段获取） ───────────────────
  const toast = useToast()

  // ── 进度状态 ───────────────────────────────────────────
  const isRunning = ref(false)
  const isScanning = ref(false)
  const scannedCount = ref(0)
  const resolvedFiles = ref<SyncFileInfo[]>([])
  const progress = ref<Record<string, CellStatus>>({})
  const taskSummary = ref<{ total: number; success: number; failed: number } | null>(null)
  let eventSource: EventSource | null = null

  // ── Modal 状态 ─────────────────────────────────────────
  const modalPhase = ref<'select' | 'progress' | 'done'>('select')
  const sourceContext = ref<SyncSource | null>(null)

  /** 任务是否活跃（进行中或已完成但未重置） */
  const taskActive = computed(() => isRunning.value || taskSummary.value !== null)

  // ── 工具方法 ───────────────────────────────────────────

  function cellKey(instanceId: string, fileName: string): string {
    return instanceId + '::' + fileName
  }

  function getCell(instanceId: string, fileName: string): CellStatus {
    return progress.value[cellKey(instanceId, fileName)] ?? null
  }

  function getSelectedInstances(groups: InstanceGroup[]): MinioInstance[] {
    const result: MinioInstance[] = []
    const seen = new Set<string>()
    for (const g of groups) {
      for (const inst of g.instances) {
        if (targetInstanceIds.value.has(inst.id) && inst.enabled && !seen.has(inst.id)) {
          result.push(inst)
          seen.add(inst.id)
        }
      }
    }
    return result
  }

  // ── 目标端 bucket 管理（复用 useDispatch 模式） ──────────

  function getInstanceBucket(inst: MinioInstance): string {
    return targetBuckets.value[inst.id] ?? ''
  }

  function setInstanceBucket(instanceId: string, bucket: string) {
    targetBuckets.value[instanceId] = bucket
  }

  function setGroupBucket(groups: InstanceGroup[], groupId: string, bucket: string) {
    const g = groups.find(g => g.id === groupId)
    if (!g) return
    const next = { ...targetBuckets.value }
    for (const inst of g.instances) {
      if (targetInstanceIds.value.has(inst.id) && inst.enabled) {
        next[inst.id] = bucket
      }
    }
    targetBuckets.value = next
  }

  async function loadTargetBuckets(groups: InstanceGroup[]) {
    const selected = getSelectedInstances(groups)
    const needLoad = selected.filter(inst => !targetBucketOptions.value[inst.id])
    if (!needLoad.length) return

    for (const inst of needLoad) {
      targetBucketOptions.value[inst.id] = { buckets: [], loading: true }
    }

    try {
      const result = await $fetch<Record<string, { buckets: string[], error?: string }>>('/api/instances/buckets', {
        method: 'POST',
        body: { instanceIds: needLoad.map(i => i.id) },
      })

      for (const inst of needLoad) {
        const r = result[inst.id]
        if (r) {
          targetBucketOptions.value[inst.id] = {
            buckets: r.buckets,
            loading: false,
            error: r.error,
          }
          if (r.buckets.length === 1 && !targetBuckets.value[inst.id] && r.buckets[0]) {
            targetBuckets.value[inst.id] = r.buckets[0]
          }
        }
      }
    } catch (e: any) {
      for (const inst of needLoad) {
        targetBucketOptions.value[inst.id] = {
          buckets: [],
          loading: false,
          error: e?.data?.statusMessage || e?.message || '请求失败',
        }
      }
    }
  }

  function getInstanceBucketOptions(inst: MinioInstance): BucketLoadState {
    return targetBucketOptions.value[inst.id] ?? { buckets: [], loading: false }
  }

  function getGroupBucketIntersection(groups: InstanceGroup[], groupId: string): string[] {
    const g = groups.find(g => g.id === groupId)
    if (!g) return []
    const selected = g.instances.filter(i => targetInstanceIds.value.has(i.id) && i.enabled)
    if (!selected.length) return []

    const bucketSets = selected.map(inst => {
      const opts = targetBucketOptions.value[inst.id]
      return new Set(opts?.buckets ?? [])
    })

    const readySets = bucketSets.filter(s => s.size >= 0)
    if (!readySets.length) return []

    let intersection = readySets[0]!
    for (let i = 1; i < readySets.length; i++) {
      intersection = new Set([...intersection].filter(x => readySets[i]!.has(x)))
    }
    return [...intersection].sort()
  }

  // ── 进度聚合 ───────────────────────────────────────────

  function getInstanceProgress(instanceId: string): { completed: number; total: number; failed: number } {
    let completed = 0
    let failed = 0
    for (const f of resolvedFiles.value) {
      const cell = progress.value[cellKey(instanceId, f.relativeKey)]
      if (cell && cell !== 'running') {
        completed++
        if (typeof cell === 'object' && cell.status === 'failed') failed++
      }
    }
    return { completed, total: resolvedFiles.value.length, failed }
  }

  /** 总完成数（所有实例合计） */
  const totalCompleted = computed(() => {
    let count = 0
    for (const key of Object.keys(progress.value)) {
      const cell = progress.value[key]
      if (cell && cell !== 'running') count++
    }
    return count
  })

  /** 总数（文件数 × 目标实例数） */
  const totalCount = computed(() => {
    return resolvedFiles.value.length * targetInstanceIds.value.size
  })

  // ── 同步提交 ───────────────────────────────────────────

  async function submit(source: SyncSource, groups: InstanceGroup[]) {
    if (isRunning.value) return

    

    const selected = getSelectedInstances(groups)
    if (!selected.length) {
      toast.add({ title: '请先选择目标实例', color: 'warning' })
      return
    }

    // 校验：源实例作为目标时，目标 bucket 不能等于源 bucket
    if (targetInstanceIds.value.has(source.instanceId)) {
      const targetBucket = targetBuckets.value[source.instanceId]
      if (targetBucket === source.bucket) {
        toast.add({ title: '源实例的目标 bucket 不能与源 bucket 相同', color: 'warning' })
        return
      }
    }

    // 凭据提醒
    const authFailed = selected.filter(inst => targetBucketOptions.value[inst.id]?.error)
    if (authFailed.length) {
      toast.add({
        title: '部分目标实例凭据可能无效',
        description: authFailed.map(i => i.name).join('、'),
        color: 'warning',
      })
    }

    // 校验所有实例都有 bucket
    const noBucket = selected.filter(inst => !getInstanceBucket(inst))
    if (noBucket.length) {
      toast.add({
        title: '部分目标实例未指定 bucket',
        description: noBucket.map(i => i.name).join('、'),
        color: 'warning',
      })
      return
    }

    // 重置进度
    progress.value = {}
    taskSummary.value = null
    isScanning.value = true
    isRunning.value = true
    scannedCount.value = 0
    resolvedFiles.value = []
    sourceContext.value = source
    modalPhase.value = 'progress'

    try {
      const res = await $fetch<{ taskId: string }>('/api/sync', {
        method: 'POST',
        body: {
          source,
          targets: {
            instanceIds: selected.map(i => i.id),
            instanceBuckets: Object.fromEntries(
              selected.map(i => [i.id, getInstanceBucket(i)]),
            ),
            prefix: targetPrefix.value || '',
          },
        },
      })

      subscribeSSE(res.taskId, selected)
    } catch (e: any) {
      isRunning.value = false
      isScanning.value = false
      modalPhase.value = 'select'
      toast.add({ title: '提交同步失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
    }
  }

  function subscribeSSE(tid: string, selected: MinioInstance[]) {
    eventSource = new EventSource('/api/sync/events?taskId=' + tid)

    eventSource.addEventListener('scan-progress', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      isScanning.value = true
      scannedCount.value = data.scannedCount ?? 0
    })

    eventSource.addEventListener('scan-complete', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      isScanning.value = false
      resolvedFiles.value = data.files ?? []

      // 初始化所有 instance×file 为 running
      const next: Record<string, CellStatus> = {}
      for (const inst of selected) {
        for (const f of resolvedFiles.value) {
          next[cellKey(inst.id, f.relativeKey)] = 'running'
        }
      }
      progress.value = next
    })

    eventSource.addEventListener('start', () => {
      isScanning.value = false
    })

    eventSource.addEventListener('progress', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      if (data.result) {
        progress.value[cellKey(data.result.instanceId, data.result.fileName)] = data.result
      }
    })

    eventSource.addEventListener('complete', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      taskSummary.value = data.summary
      isRunning.value = false
      isScanning.value = false
      modalPhase.value = 'done'

      // 兜底：未收到结果的标记 failed
      for (const inst of selected) {
        for (const f of resolvedFiles.value) {
          const k = cellKey(inst.id, f.relativeKey)
          if (progress.value[k] === 'running') {
            progress.value[k] = {
              instanceId: inst.id,
              instanceName: inst.name,
              fileName: f.relativeKey,
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
        title: '同步完成',
        description: '共 ' + s.total + ' 个，成功 ' + s.success + ' 个，失败 ' + s.failed + ' 个',
        color: s.failed > 0 ? 'warning' : 'success',
      })
    })

    eventSource.onerror = () => {
      if (isRunning.value) {
        isRunning.value = false
        isScanning.value = false
        
        toast.add({ title: '连接中断', description: 'SSE 连接异常，进度可能不完整', color: 'error' })
      }
      eventSource?.close()
      eventSource = null
    }
  }

  function reset() {
    eventSource?.close()
    eventSource = null
    isRunning.value = false
    isScanning.value = false
    scannedCount.value = 0
    resolvedFiles.value = []
    progress.value = {}
    taskSummary.value = null
    modalPhase.value = 'select'
    sourceContext.value = null
    targetInstanceIds.value = new Set()
    targetBuckets.value = {}
    targetBucketOptions.value = {}
    targetPrefix.value = ''
  }

  /** 重置到选择阶段（保留目标选择，清除进度） */
  function resetToSelect() {
    eventSource?.close()
    eventSource = null
    isRunning.value = false
    isScanning.value = false
    scannedCount.value = 0
    resolvedFiles.value = []
    progress.value = {}
    taskSummary.value = null
    modalPhase.value = 'select'
    sourceContext.value = null
  }

  return {
    // 目标端
    targetInstanceIds,
    targetBuckets,
    targetBucketOptions,
    targetPrefix,
    getInstanceBucket,
    setInstanceBucket,
    setGroupBucket,
    loadTargetBuckets,
    getInstanceBucketOptions,
    getGroupBucketIntersection,
    // 进度
    isRunning,
    isScanning,
    scannedCount,
    resolvedFiles,
    progress,
    taskSummary,
    taskActive,
    totalCompleted,
    totalCount,
    modalPhase,
    sourceContext,
    getCell,
    getSelectedInstances,
    getInstanceProgress,
    cellKey,
    // 操作
    submit,
    reset,
    resetToSelect,
  }
}
