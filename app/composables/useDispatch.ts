/**
 * 分发相关前端逻辑
 *
 * 状态管理：文件、选中目标、按实例 bucket（异步从 MinIO 拉取）、进度矩阵、运行状态。
 */

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
interface DispatchResult {
  groupId: string
  instanceId: string
  instanceName: string
  fileName: string
  status: 'success' | 'failed'
  error?: string
  duration?: number
}

/** 单元格状态 */
type CellStatus = DispatchResult | 'running' | null

/** 实例 bucket 加载状态 */
interface BucketLoadState {
  buckets: string[]
  loading: boolean
  error?: string
}

export function useDispatch() {
  const files = ref<{ name: string; content: string }[]>([])
  const selectedInstanceIds = ref<Set<string>>(new Set())

  // 按实例指定 bucket
  const instanceBuckets = ref<Record<string, string>>({})

  // 按实例的 bucket 候选列表（异步从 MinIO 拉取）
  const instanceBucketOptions = ref<Record<string, BucketLoadState>>({})

  const progress = ref<Record<string, CellStatus>>({})
  const isRunning = ref(false)
  const taskSummary = ref<{ total: number; success: number; failed: number } | null>(null)
  let eventSource: EventSource | null = null

  function cellKey(instanceId: string, fileName: string): string {
    return `${instanceId}::${fileName}`
  }

  function getCell(instanceId: string, fileName: string): CellStatus {
    return progress.value[cellKey(instanceId, fileName)] ?? null
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

  /** 获取实例当前设置的 bucket */
  function getInstanceBucket(inst: MinioInstance): string {
    return instanceBuckets.value[inst.id] ?? ''
  }

  /** 设置单个实例的 bucket */
  function setInstanceBucket(instanceId: string, bucket: string) {
    instanceBuckets.value[instanceId] = bucket
  }

  /** 批量设置组内选中实例的 bucket */
  function setGroupBucket(groups: InstanceGroup[], groupId: string, bucket: string) {
    const g = groups.find(g => g.id === groupId)
    if (!g) return
    const next = { ...instanceBuckets.value }
    for (const inst of g.instances) {
      if (selectedInstanceIds.value.has(inst.id) && inst.enabled) {
        next[inst.id] = bucket
      }
    }
    instanceBuckets.value = next
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
          // 如果只有一个 bucket 且实例未设 bucket，自动选中
          if (r.buckets.length === 1 && !instanceBuckets.value[inst.id] && r.buckets[0]) {
            instanceBuckets.value[inst.id] = r.buckets[0]
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

  /** 获取实例的 bucket 候选列表 */
  function getInstanceBucketOptions(inst: MinioInstance): BucketLoadState {
    return instanceBucketOptions.value[inst.id] ?? { buckets: [], loading: false }
  }

  /**
   * 计算组内选中实例的 bucket 交集（用于组级批量选择器候选）。
   */
  function getGroupBucketIntersection(groups: InstanceGroup[], groupId: string): string[] {
    const g = groups.find(g => g.id === groupId)
    if (!g) return []
    const selected = g.instances.filter(i => selectedInstanceIds.value.has(i.id) && i.enabled)
    if (!selected.length) return []

    // 取所有选中实例已加载 bucket 的交集
    const bucketSets = selected.map(inst => {
      const opts = instanceBucketOptions.value[inst.id]
      return new Set(opts?.buckets ?? [])
    })

    // 过滤掉 loading 或 error 的实例
    const readySets = bucketSets.filter(s => s.size >= 0)
    if (!readySets.length) return []

    // 交集
    let intersection = readySets[0]!
    for (let i = 1; i < readySets.length; i++) {
      intersection = new Set([...intersection].filter(x => readySets[i]!.has(x)))
    }
    return [...intersection].sort()
  }

  /** 提交分发任务 */
  async function submit(groups: InstanceGroup[]) {
    if (isRunning.value) return
    if (!files.value.length) {
      const toast = useToast()
      toast.add({ title: '请先选择文件', color: 'warning' })
      return
    }

    const selected = getSelectedInstances(groups)
    if (!selected.length) {
      const toast = useToast()
      toast.add({ title: '请先选择目标实例', color: 'warning' })
      return
    }

    // 校验所有实例都有 bucket
    const noBucket = selected.filter(inst => !getInstanceBucket(inst))
    if (noBucket.length) {
      const toast = useToast()
      toast.add({
        title: '部分实例未指定 bucket',
        description: noBucket.map(i => i.name).join('、'),
        color: 'warning',
      })
      return
    }

    progress.value = {}
    taskSummary.value = null
    isRunning.value = true

    const toast = useToast()
    try {
      const groupIds = Array.from(new Set(selected.map(i => i.groupId)))
      const instanceIds = selected.map(i => i.id)

      const buckets: Record<string, string> = {}
      for (const inst of selected) {
        const b = getInstanceBucket(inst)
        if (b) buckets[inst.id] = b
      }

      const res = await $fetch<{ taskId: string }>('/api/dispatch', {
        method: 'POST',
        body: {
          files: files.value,
          groupIds,
          instanceIds,
          instanceBuckets: buckets,
        },
      })

      eventSource = new EventSource(`/api/dispatch/events?taskId=${res.taskId}`)

      eventSource.addEventListener('start', () => {
        for (const inst of selected) {
          for (const f of files.value) {
            progress.value[cellKey(inst.id, f.name)] = 'running'
          }
        }
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
        for (const inst of selected) {
          for (const f of files.value) {
            const k = cellKey(inst.id, f.name)
            if (progress.value[k] === 'running') {
              progress.value[k] = {
                groupId: inst.groupId,
                instanceId: inst.id,
                instanceName: inst.name,
                fileName: f.name,
                status: 'failed',
                error: '未收到结果',
              }
            }
          }
        }
        eventSource?.close()
        eventSource = null

        const s = data.summary
        try {
          sessionStorage.setItem('last-dispatch', JSON.stringify({
            total: s.total,
            success: s.success,
            failed: s.failed,
            time: new Date().toLocaleString('zh-CN'),
          }))
        } catch {}

        toast.add({
          title: '分发完成',
          description: `共 ${s.total} 个，成功 ${s.success} 个，失败 ${s.failed} 个`,
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
      toast.add({ title: '分发失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
    }
  }

  function cancel() {
    eventSource?.close()
    eventSource = null
    isRunning.value = false
  }

  return {
    files,
    selectedInstanceIds,
    instanceBuckets,
    instanceBucketOptions,
    progress,
    isRunning,
    taskSummary,
    submit,
    cancel,
    getCell,
    getSelectedInstances,
    getInstanceBucket,
    setInstanceBucket,
    setGroupBucket,
    loadBuckets,
    getInstanceBucketOptions,
    getGroupBucketIntersection,
    cellKey,
  }
}
