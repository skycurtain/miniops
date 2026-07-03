/**
 * 分发相关前端逻辑
 *
 * 状态管理：文件、选中目标、按实例 bucket、进度矩阵、运行状态。
 * submit() 提交任务并建立 SSE 监听。
 */

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
interface DispatchResult {
  groupId: string
  instanceId: string
  instanceName: string
  fileName: string
  status: 'success' | 'failed'
  error?: string
  duration?: number
}

/** 单元格状态：null=未处理, 'running'=进行中, DispatchResult=已完成 */
type CellStatus = DispatchResult | 'running' | null

export function useDispatch() {
  // 选择的文件（文件名 + 内容）
  const files = ref<{ name: string; content: string }[]>([])

  // 选中的目标
  const selectedInstanceIds = ref<Set<string>>(new Set())

  // 按实例指定 bucket：instanceId → bucket
  // 初始为空，页面会自动用实例自身的 bucket 填充
  const instanceBuckets = ref<Record<string, string>>({})

  // 进度矩阵：key = `${instanceId}::${fileName}`，value = 状态
  const progress = ref<Record<string, CellStatus>>({})

  // 运行状态
  const isRunning = ref(false)
  const taskSummary = ref<{ total: number; success: number; failed: number } | null>(null)
  let eventSource: EventSource | null = null

  /** 构造矩阵 key */
  function cellKey(instanceId: string, fileName: string): string {
    return `${instanceId}::${fileName}`
  }

  /** 获取单元格状态 */
  function getCell(instanceId: string, fileName: string): CellStatus {
    return progress.value[cellKey(instanceId, fileName)] ?? null
  }

  /** 计算选中实例列表 */
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

  /**
   * 收集所有实例的 bucket 去重，作为选择器候选列表。
   * 注意：不只收集选中的，而是全部实例的 bucket（用户可能想统一换成别的）。
   */
  function getAllBucketOptions(groups: InstanceGroup[]): string[] {
    const set = new Set<string>()
    for (const g of groups) {
      for (const inst of g.instances) {
        if (inst.bucket) set.add(inst.bucket)
      }
    }
    return Array.from(set).sort()
  }

  /** 获取某个实例当前设置的 bucket（instanceBuckets 优先，回退到实例默认） */
  function getInstanceBucket(inst: MinioInstance): string {
    return instanceBuckets.value[inst.id] ?? inst.bucket ?? ''
  }

  /** 设置单个实例的 bucket */
  function setInstanceBucket(instanceId: string, bucket: string) {
    instanceBuckets.value[instanceId] = bucket
  }

  /** 批量设置组内选中实例的 bucket */
  function setGroupBucket(groups: InstanceGroup[], groupId: string, bucket: string) {
    const g = groups.find(g => g.id === groupId)
    if (!g) return
    for (const inst of g.instances) {
      if (selectedInstanceIds.value.has(inst.id) && inst.enabled) {
        instanceBuckets.value[inst.id] = bucket
      }
    }
  }

  /**
   * 提交分发任务
   * @param groups 当前所有组（用于展开 groupIds）
   */
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

    // 检查是否所有实例都有 bucket
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

    // 重置进度矩阵
    progress.value = {}
    taskSummary.value = null
    isRunning.value = true

    const toast = useToast()
    try {
      const groupIds = Array.from(new Set(selected.map(i => i.groupId)))
      const instanceIds = selected.map(i => i.id)

      // 构造 instanceBuckets：只传与实例默认值不同的（减少请求体）
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

      // 建立 SSE 连接
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

  /** 取消分发（关闭 SSE） */
  function cancel() {
    eventSource?.close()
    eventSource = null
    isRunning.value = false
  }

  return {
    files,
    selectedInstanceIds,
    instanceBuckets,
    progress,
    isRunning,
    taskSummary,
    submit,
    cancel,
    getCell,
    getSelectedInstances,
    getAllBucketOptions,
    getInstanceBucket,
    setInstanceBucket,
    setGroupBucket,
    cellKey,
  }
}
