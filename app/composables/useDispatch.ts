/**
 * 分发相关前端逻辑
 *
 * 状态管理：文件、选中目标、bucket、进度矩阵、运行状态。
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

  // 分发 bucket（覆盖实例默认值）
  const bucket = ref<string>('')

  // 进度矩阵：key = `${instanceId}::${fileName}`，value = 状态
  const progress = ref<Record<string, CellStatus>>({})

  // 运行状态
  const isRunning = ref(false)
  const taskSummary = ref<{ total: number; success: number; failed: number } | null>(null)
  let eventSource: EventSource | null = null

  /** bucket 候选项：选中实例的 bucket 去重（排除空值） */
  const bucketOptions = computed(() => {
    const set = new Set<string>()
    // 需要从外部传入 groups 数据
    return set
  })

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

  /** 计算选中实例的 bucket 候选项（去重） */
  function getBucketOptions(groups: InstanceGroup[]): string[] {
    const set = new Set<string>()
    for (const inst of getSelectedInstances(groups)) {
      if (inst.bucket) set.add(inst.bucket)
    }
    return Array.from(set)
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

    // 重置进度矩阵：所有单元格设为 null
    progress.value = {}
    taskSummary.value = null
    isRunning.value = true

    const toast = useToast()
    try {
      // 从选中的实例收集 groupIds
      const groupIds = Array.from(new Set(selected.map(i => i.groupId)))
      const instanceIds = selected.map(i => i.id)

      const res = await $fetch<{ taskId: string }>('/api/dispatch', {
        method: 'POST',
        body: {
          files: files.value,
          groupIds,
          instanceIds,
          bucket: bucket.value || undefined,
        },
      })

      // 建立 SSE 连接
      eventSource = new EventSource(`/api/dispatch/events?taskId=${res.taskId}`)

      eventSource.addEventListener('start', () => {
        // 标记所有单元格为 'running'
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
        // 把仍为 'running' 的单元格标记为 failed（理论上不应有）
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
        toast.add({
          title: '分发完成',
          description: `共 ${s.total} 个，成功 ${s.success} 个，失败 ${s.failed} 个`,
          color: s.failed > 0 ? 'warning' : 'success',
        })
      })

      eventSource.onerror = () => {
        // SSE 连接异常（非正常关闭）
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
    bucket,
    progress,
    isRunning,
    taskSummary,
    submit,
    cancel,
    getCell,
    getSelectedInstances,
    getBucketOptions,
    cellKey,
  }
}
