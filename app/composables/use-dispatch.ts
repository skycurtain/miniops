import { formatSize, fileIcon } from '~/utils/browse'
import type { TreeItem } from '@nuxt/ui'
import type { InstanceGroup, MinioInstance } from '#shared/schemas/groups'
import type { BucketInfo } from '#shared/schemas/browse'
import type { FileResult } from '#shared/schemas/task'
import { useTaskManager } from '~/composables/use-task-manager'

// ==================== 类型定义 ====================

export interface DispatchTreeItem extends TreeItem {
  instanceId?: string
  groupId?: string
  children?: DispatchTreeItem[]
}

export interface StagedFile {
  id: string
  rawFile: File
  name: string
  objectKey: string
  size: number
  contentType: string
  status: 'ready' | 'uploading' | 'done' | 'error'
  progress: number
  error?: string
  fileId?: string
  folderName?: string
}

export interface FileGroup {
  type: 'file' | 'folder'
  folderName?: string
  items: StagedFile[]
  totalSize: number
  anyUploading: boolean
  anyError: boolean
  allReady: boolean
}

export type Phase = 'idle' | 'staging' | 'dispatching' | 'done' | 'cancelled'

/** 分发 composable 的返回类型（用于 inject 的类型推断） */
export interface DispatchComposable {
  // 实例分组数据
  groupsData: Ref<InstanceGroup[]>
  groupsPending: Ref<boolean>
  groupsError: Ref<unknown>
  refresh: () => Promise<void>
  treeItems: ComputedRef<DispatchTreeItem[]>
  findGroupById: (id: string) => InstanceGroup | undefined
  findInstanceById: (id: string) => MinioInstance | undefined
  onInstanceNodeClick: (instId: string) => void
  showGroupBucketRow: (g: InstanceGroup) => boolean

  // 目标选择
  selectedInstances: Ref<Set<string>>
  instanceBuckets: Ref<Record<string, string>>
  bucketsCache: Ref<Record<string, BucketInfo[]>>
  bucketLoading: Ref<Set<string>>
  bucketError: Ref<Record<string, string>>
  loadBuckets: (instId: string) => Promise<BucketInfo[]>
  getBuckets: (instId: string) => BucketInfo[]
  reloadBuckets: (instId: string) => Promise<void>
  toggleInstance: (inst: MinioInstance) => void
  isGroupAllSelected: (g: InstanceGroup) => boolean
  isGroupPartialSelected: (g: InstanceGroup) => boolean
  toggleGroup: (g: InstanceGroup) => void
  getGroupCommonBuckets: (g: InstanceGroup) => BucketInfo[]
  applyGroupBucket: (g: InstanceGroup, bucket: string) => void
  getAllCommonBuckets: () => string[]
  applyBucketToAll: (bucket: string) => void
  commonBucketValue: ComputedRef<string | undefined>
  findGroupByInstanceId: (instanceId: string) => InstanceGroup | undefined
  selectedInstancesList: ComputedRef<MinioInstance[]>
  prefix: Ref<string>

  // 文件选择
  files: Ref<StagedFile[]>
  fileInput: Ref<HTMLInputElement | undefined>
  folderInput: Ref<HTMLInputElement | undefined>
  onFilesSelected: (e: Event) => void
  onFolderSelected: (e: Event) => void
  removeFile: (id: string) => void
  fileGroups: ComputedRef<FileGroup[]>
  folderExpanded: Ref<Record<string, boolean>>
  readyCount: ComputedRef<number>

  // 分发状态机
  phase: Ref<Phase>
  progressMatrix: Ref<Record<string, Record<string, FileResult>>>
  instanceMeta: Ref<Record<string, { instanceId: string; instanceName: string; bucket: string }>>
  taskSummary: ComputedRef<{ total: number; success: number; failed: number; skipped: number } | null>
  progressExpanded: Ref<Record<string, boolean>>
  currentTaskId: Ref<string | null>

  // 分发操作
  startDispatch: () => Promise<void>
  cancelStaging: () => void
  cancelDispatch: () => Promise<void>
  backgroundContinue: () => void
  resetToIdle: () => void
  retryInstance: (instId: string) => Promise<void>

  // computed
  canSubmit: ComputedRef<boolean>
  canBackground: ComputedRef<boolean>
  showProgress: ComputedRef<boolean>
  progressInstanceList: ComputedRef<{ id: string; name: string; bucket: string }[]>
  phaseLabel: ComputedRef<string>
  stagingOverall: ComputedRef<{ percent: number; done: number; total: number }>

  // 工具函数
  getInstanceProgress: (instId: string) => { completed: number; total: number; failed: number; success: number }
  getOverallProgress: () => number
  formatSize: typeof formatSize
  fileIcon: typeof fileIcon
}

// ==================== composable ====================

/**
 * 分发页 composable。
 *
 * 设计要点：
 * - 用普通 ref 而非 useState，因为分发状态是页面级、非跨页面全局共享的。
 * - 由 index.vue 在 setup 顶层调用一次，通过 provide/inject 传递给子组件，
 *   确保状态只初始化一次且子组件共享同一份引用。
 *
 * phase 切换修复：
 * - useTaskManager.finalize() 会先把 activeTasks 中对应任务设为带终态的对象，再在 nextTick 移除。
 * - watch(activeTasks, deep) 能在终态对象被设置时捕获到 status 变化并更新 phase。
 * - watch(completedTasks, deep) 作为兜底：当任务从 activeTasks 移除后，completedTasks 中
 *   已包含终态任务，确保 phase 一定能切换。
 */
export function useDispatch(): DispatchComposable {
  const toast = useToast()
  const { subscribeTask, cancelTask, activeTasks, completedTasks } = useTaskManager()

  // ==================== 实例分组数据 ====================
  const { data: groupsData, pending: groupsPending, error: groupsError, refresh } = useFetch<InstanceGroup[]>(
    '/api/manage/groups',
    { default: () => [] },
  )

  // ==================== 目标实例树 ====================
  const treeItems = computed<DispatchTreeItem[]>(() =>
    (groupsData.value ?? []).map(g => ({
      label: g.name,
      icon: 'i-lucide-folder',
      groupId: g.id,
      defaultExpanded: true,
      children: g.instances.map(i => ({
        label: i.name,
        icon: 'i-lucide-server',
        instanceId: i.id,
        disabled: !i.enabled,
      })),
    })),
  )

  function findGroupById(id: string): InstanceGroup | undefined {
    return groupsData.value?.find(g => g.id === id)
  }

  function findInstance(id: string): MinioInstance | undefined {
    for (const g of groupsData.value ?? []) {
      const inst = g.instances.find(i => i.id === id)
      if (inst) return inst
    }
    return undefined
  }

  function findInstanceById(id: string): MinioInstance | undefined {
    return findInstance(id)
  }

  /** 点击实例节点行（非 checkbox 区域）切换选中 */
  function onInstanceNodeClick(instId: string) {
    if (phase.value !== 'idle') return
    const inst = findInstance(instId)
    if (inst?.enabled) toggleInstance(inst)
  }

  /** 分组是否显示批量 bucket 设置行 */
  function showGroupBucketRow(g: InstanceGroup): boolean {
    return (isGroupAllSelected(g) || isGroupPartialSelected(g)) && phase.value === 'idle'
  }

  // ==================== 目标选择 ====================
  const selectedInstances = ref<Set<string>>(new Set())
  const instanceBuckets = ref<Record<string, string>>({})
  const bucketsCache = ref<Record<string, BucketInfo[]>>({})
  const bucketLoading = ref<Set<string>>(new Set())
  const bucketError = ref<Record<string, string>>({})

  /** 选中实例列表（按 groups 顺序） */
  const selectedInstancesList = computed<MinioInstance[]>(() => {
    const list: MinioInstance[] = []
    for (const g of groupsData.value ?? []) {
      for (const i of g.instances) {
        if (selectedInstances.value.has(i.id)) list.push(i)
      }
    }
    return list
  })

  /** 加载实例的 bucket 列表（带缓存） */
  async function loadBuckets(instId: string) {
    if (bucketsCache.value[instId]) return bucketsCache.value[instId]!
    bucketLoading.value = new Set([...bucketLoading.value, instId])
    delete bucketError.value[instId]
    try {
      const res = await $fetch<{ buckets: BucketInfo[]; error?: string }>('/api/browse/buckets', {
        query: { instanceId: instId },
      })
      if (res.error) {
        bucketError.value[instId] = res.error
        bucketsCache.value[instId] = []
      } else {
        bucketsCache.value[instId] = res.buckets
      }
      return bucketsCache.value[instId]!
    } catch (e: unknown) {
      const err = e as { data?: { message?: string }; message?: string }
      bucketError.value[instId] = err?.data?.message || err?.message || '加载失败'
      bucketsCache.value[instId] = []
      return []
    } finally {
      const next = new Set(bucketLoading.value)
      next.delete(instId)
      bucketLoading.value = next
    }
  }

  function getBuckets(instId: string): BucketInfo[] {
    return bucketsCache.value[instId] ?? []
  }

  /** 重新加载实例的 bucket 列表（清除缓存） */
  async function reloadBuckets(instId: string) {
    const next = { ...bucketsCache.value }
    delete next[instId]
    bucketsCache.value = next
    await loadBuckets(instId)
  }

  function toggleInstance(inst: MinioInstance) {
    if (!inst.enabled) return
    if (selectedInstances.value.has(inst.id)) {
      const next = new Set(selectedInstances.value)
      next.delete(inst.id)
      selectedInstances.value = next
      delete instanceBuckets.value[inst.id]
    } else {
      const next = new Set(selectedInstances.value)
      next.add(inst.id)
      selectedInstances.value = next
      void loadBuckets(inst.id)
    }
  }

  function isGroupAllSelected(g: InstanceGroup): boolean {
    const enabled = g.instances.filter(i => i.enabled)
    return enabled.length > 0 && enabled.every(i => selectedInstances.value.has(i.id))
  }

  function isGroupPartialSelected(g: InstanceGroup): boolean {
    const enabled = g.instances.filter(i => i.enabled)
    const selected = enabled.filter(i => selectedInstances.value.has(i.id))
    return selected.length > 0 && selected.length < enabled.length
  }

  function toggleGroup(g: InstanceGroup) {
    const enabled = g.instances.filter(i => i.enabled)
    if (!enabled.length) return
    const next = new Set(selectedInstances.value)
    if (isGroupAllSelected(g)) {
      enabled.forEach(i => {
        next.delete(i.id)
        delete instanceBuckets.value[i.id]
      })
    } else {
      enabled.forEach(i => {
        next.add(i.id)
        if (!bucketsCache.value[i.id]) void loadBuckets(i.id)
      })
    }
    selectedInstances.value = next
  }

  function getGroupCommonBuckets(g: InstanceGroup): BucketInfo[] {
    const selected = g.instances.filter(i => selectedInstances.value.has(i.id))
    if (!selected.length) return []
    const bucketLists = selected
      .map(i => bucketsCache.value[i.id] ?? [])
      .filter(b => b.length > 0)
    if (!bucketLists.length) return []
    const nameSets = bucketLists.map(b => new Set(b.map(x => x.name)))
    return bucketLists[0]!.filter(b => nameSets.every(s => s.has(b.name)))
  }

  function applyGroupBucket(g: InstanceGroup, bucket: string) {
    const next = { ...instanceBuckets.value }
    g.instances.filter(i => selectedInstances.value.has(i.id)).forEach(i => {
      next[i.id] = bucket
    })
    instanceBuckets.value = next
  }

  /** 获取所有选中实例的公共 bucket 列表 */
  function getAllCommonBuckets(): string[] {
    const selected = selectedInstancesList.value
    if (!selected.length) return []
    const sets = selected.map(i => new Set(getBuckets(i.id).map(b => b.name)))
    return getBuckets(selected[0]!.id).map(b => b.name).filter(name => sets.every(s => s.has(name)))
  }

  /** 批量设置所有选中实例的 bucket */
  function applyBucketToAll(bucket: string) {
    const next = { ...instanceBuckets.value }
    selectedInstancesList.value.forEach(i => {
      next[i.id] = bucket
    })
    instanceBuckets.value = next
  }

  /** 公共 bucket 当前值：所有实例 bucket 相同时返回该值，否则 undefined */
  const commonBucketValue = computed<string | undefined>(() => {
    const selected = selectedInstancesList.value
    if (selected.length === 0) return undefined
    const first = instanceBuckets.value[selected[0]!.id]
    if (!first) return undefined
    return selected.every(i => instanceBuckets.value[i.id] === first) ? first : undefined
  })

  /** 查找实例所属分组 */
  function findGroupByInstanceId(instanceId: string): InstanceGroup | undefined {
    return (groupsData.value ?? []).find(g => g.instances.some(i => i.id === instanceId))
  }

  const prefix = ref('')

  // ==================== 文件选择 ====================
  const files = ref<StagedFile[]>([])
  const fileInput = ref<HTMLInputElement>()
  const folderInput = ref<HTMLInputElement>()

  function onFilesSelected(e: Event) {
    const input = e.target as HTMLInputElement
    if (!input.files) return
    for (const f of Array.from(input.files)) {
      files.value.push({
        id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        rawFile: f,
        name: f.name,
        objectKey: f.name,
        size: f.size,
        contentType: f.type || 'application/octet-stream',
        status: 'ready',
        progress: 0,
      })
    }
    input.value = ''
  }

  function onFolderSelected(e: Event) {
    const input = e.target as HTMLInputElement
    if (!input.files) return
    for (const f of Array.from(input.files)) {
      const relativePath = (f as any).webkitRelativePath as string || f.name
      const parts = relativePath.split('/')
      const folderName = parts.length > 1 ? parts[0] : undefined
      const objectKey = parts.length > 1 ? parts.slice(1).join('/') : f.name
      files.value.push({
        id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        rawFile: f,
        name: f.name,
        objectKey,
        size: f.size,
        contentType: f.type || 'application/octet-stream',
        status: 'ready',
        progress: 0,
        folderName,
      })
    }
    input.value = ''
  }

  function removeFile(id: string) {
    files.value = files.value.filter(f => f.id !== id)
  }

  // 文件分组展示：单文件逐个 + 文件夹聚合
  const fileGroups = computed<FileGroup[]>(() => {
    const groupMap = new Map<string, StagedFile[]>()
    const standalone: StagedFile[] = []
    for (const f of files.value) {
      if (f.folderName) {
        if (!groupMap.has(f.folderName)) groupMap.set(f.folderName, [])
        groupMap.get(f.folderName)!.push(f)
      } else {
        standalone.push(f)
      }
    }
    const result: FileGroup[] = []
    for (const [folderName, items] of groupMap) {
      result.push({
        type: 'folder',
        folderName,
        items,
        totalSize: items.reduce((s, f) => s + f.size, 0),
        anyUploading: items.some(f => f.status === 'uploading'),
        anyError: items.some(f => f.status === 'error'),
        allReady: items.every(f => f.status === 'ready'),
      })
    }
    for (const f of standalone) {
      result.push({
        type: 'file',
        items: [f],
        totalSize: f.size,
        anyUploading: f.status === 'uploading',
        anyError: f.status === 'error',
        allReady: f.status === 'ready',
      })
    }
    return result
  })

  const folderExpanded = ref<Record<string, boolean>>({})
  const readyCount = computed(() => files.value.filter(f => f.status === 'ready').length)

  // ==================== 分发状态机 ====================
  const phase = ref<Phase>('idle')

  // 分发进度（来自 SSE 的 instanceProgress，按 instanceId -> objectKey -> result）
  const progressMatrix = ref<Record<string, Record<string, FileResult>>>({})
  const instanceMeta = ref<Record<string, { instanceId: string; instanceName: string; bucket: string }>>({})
  // taskSummary 从 progressMatrix 派生（自动累计初始任务 + 重试）
  const taskSummary = computed(() => {
    let total = 0
    let success = 0
    let failed = 0
    let skipped = 0
    for (const cells of Object.values(progressMatrix.value)) {
      for (const r of Object.values(cells)) {
        total++
        if (r.status === 'success') success++
        else if (r.status === 'failed') failed++
        else if (r.status === 'skipped') skipped++
      }
    }
    // 只有存在进度数据时才有摘要
    return total > 0 ? { total, success, failed, skipped } : null
  })
  const progressExpanded = ref<Record<string, boolean>>({})

  // 暂存阶段控制
  let stagingCancelled = false
  let stagingAbortControllers: AbortController[] = []

  // 当前分发任务 ID（用于取消）
  const currentTaskId = ref<string | null>(null)

  const canSubmit = computed(() =>
    files.value.length > 0
    && readyCount.value > 0
    && selectedInstances.value.size > 0
    && selectedInstancesList.value.every(i => !!instanceBuckets.value[i.id])
    && phase.value === 'idle',
  )

  // ==================== 暂存阶段：XHR 逐文件上传 ====================
  function stageOneFile(f: StagedFile): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const abortController = new AbortController()
      stagingAbortControllers.push(abortController)

      // upload.onprogress 获取进度百分比
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100)
          f.progress = pct
        }
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const res = JSON.parse(xhr.responseText) as { fileId: string }
            f.fileId = res.fileId
            f.status = 'done'
            f.progress = 100
            resolve()
          } catch {
            f.status = 'error'
            f.error = '响应解析失败'
            reject(new Error('响应解析失败'))
          }
        } else {
          let msg = `暂存失败 (${xhr.status})`
          try {
            const res = JSON.parse(xhr.responseText) as { message?: string; statusMessage?: string }
            msg = res.message || res.statusMessage || msg
          } catch {}
          f.status = 'error'
          f.error = msg
          reject(new Error(msg))
        }
      }

      xhr.onerror = () => {
        f.status = 'error'
        f.error = '网络错误'
        reject(new Error('网络错误'))
      }

      xhr.onabort = () => {
        f.status = 'ready'
        reject(new DOMException('Aborted', 'AbortError'))
      }

      const formData = new FormData()
      formData.append('file', f.rawFile)
      formData.append('objectKey', f.objectKey)
      formData.append('originalName', f.name)

      xhr.open('POST', '/api/dispatch/stage')
      abortController.signal.addEventListener('abort', () => xhr.abort())
      xhr.send(formData)
    })
  }

  async function startDispatch() {
    phase.value = 'staging'
    stagingCancelled = false
    stagingAbortControllers = []

    const toStage = files.value.filter(f => f.status === 'ready')
    for (const f of toStage) {
      f.status = 'uploading'
      f.progress = 0
    }

    const stagedFiles: { fileId: string; objectKey: string }[] = []
    let hasError = false

    for (const f of toStage) {
      if (stagingCancelled) return
      try {
        await stageOneFile(f)
        if (f.fileId) {
          stagedFiles.push({ fileId: f.fileId, objectKey: f.objectKey })
        }
      } catch {
        hasError = true
        // 继续暂存其他文件
      }
    }

    if (stagingCancelled) return

    // 至少有一个文件暂存成功才提交分发
    if (!stagedFiles.length) {
      phase.value = 'idle'
      toast.add({ title: '暂存失败', description: '没有文件暂存成功，无法分发', color: 'error' })
      return
    }

    if (hasError) {
      toast.add({ title: '部分文件暂存失败', description: '将仅分发成功暂存的文件', color: 'warning' })
    }

    await submitDispatch(stagedFiles)
  }

  function cancelStaging() {
    stagingCancelled = true
    for (const ac of stagingAbortControllers) {
      ac.abort()
    }
    stagingAbortControllers = []
    // 重置正在上传的文件状态
    for (const f of files.value) {
      if (f.status === 'uploading') {
        f.status = 'ready'
        f.progress = 0
      }
    }
    phase.value = 'idle'
  }

  // ==================== 提交分发 ====================
  async function submitDispatch(stagedFiles: { fileId: string; objectKey: string }[]) {
    const targets = Array.from(selectedInstances.value)
      .map(id => ({ instanceId: id, bucket: instanceBuckets.value[id] }))
      .filter(t => t.bucket)

    if (!targets.length) {
      phase.value = 'idle'
      toast.add({ title: '无法分发', description: '没有有效的目标实例（缺少 bucket）', color: 'error' })
      return
    }

    // 初始化进度矩阵（pending）；taskSummary 为派生 computed，自动统计
    const initMatrix: Record<string, Record<string, FileResult>> = {}
    const initMeta: Record<string, { instanceId: string; instanceName: string; bucket: string }> = {}
    for (const t of targets) {
      const inst = findInstance(t.instanceId)
      initMatrix[t.instanceId] = {}
      initMeta[t.instanceId] = {
        instanceId: t.instanceId,
        instanceName: inst?.name || t.instanceId,
        bucket: t.bucket || '',
      }
      for (const f of stagedFiles) {
        initMatrix[t.instanceId]![f.objectKey] = { status: 'pending' }
      }
    }
    progressMatrix.value = initMatrix
    instanceMeta.value = initMeta

    phase.value = 'dispatching'

    try {
      const res = await $fetch<{ taskId: string }>('/api/dispatch', {
        method: 'POST',
        body: { files: stagedFiles, targets, prefix: prefix.value || '' },
      })
      currentTaskId.value = res.taskId
      await subscribeTask(res.taskId)
    } catch (e: unknown) {
      const err = e as { data?: { message?: string }; message?: string }
      toast.add({ title: '提交分发失败', description: err?.data?.message || err?.message || '未知错误', color: 'error' })
      phase.value = 'idle'
      progressMatrix.value = {}
      instanceMeta.value = {}
    }
  }

  // ==================== 监听 activeTasks 更新进度矩阵 ====================

  /**
   * watch activeTasks（deep）处理进度更新 + 终态 phase 切换。
   *
   * finalize() 流程：先在 activeTasks 中更新为带终态的 task，再 nextTick 移除。
   * 所以 watch 会先收到带 status=done/cancelled 的 task，此时更新 phase；
   * 随后收到数组中该任务被移除，此时直接 return。
   */
  watch(activeTasks, (tasks) => {
    if (!currentTaskId.value) return
    const task = tasks.find(t => t.taskId === currentTaskId.value)
    if (!task) return

    // 合并 instanceProgress 到进度矩阵（重新赋值以触发响应式）
    if (task.instanceProgress) {
      const nextMatrix: Record<string, Record<string, FileResult>> = {}
      const nextMeta = { ...instanceMeta.value }
      for (const inst of task.instanceProgress) {
        // 保留已有的进度（如初始 pending），用服务端结果覆盖
        const existing = progressMatrix.value[inst.instanceId] ?? {}
        nextMatrix[inst.instanceId] = { ...existing }
        nextMeta[inst.instanceId] = {
          instanceId: inst.instanceId,
          instanceName: inst.instanceName || inst.instanceId,
          bucket: inst.bucket,
        }
        for (const [objectKey, result] of Object.entries(inst.results)) {
          nextMatrix[inst.instanceId]![objectKey] = result
        }
      }
      // 保留不在本次快照中的实例进度（重试场景下可能有多个任务）
      for (const [id, cells] of Object.entries(progressMatrix.value)) {
        if (!nextMatrix[id]) nextMatrix[id] = cells
      }
      progressMatrix.value = nextMatrix
      instanceMeta.value = nextMeta
    }

    // 更新 phase（终态归档时 activeTasks 中先被设为带终态的对象）
    if (task.status === 'done') {
      phase.value = 'done'
    } else if (task.status === 'cancelled') {
      phase.value = 'cancelled'
    } else if (task.status === 'failed') {
      phase.value = 'done'
    }
  }, { deep: true })

  /**
   * watch completedTasks（deep）兜底处理 phase 切换。
   *
   * 当 activeTask 被 finalize 清空后，completedTasks 中已包含终态任务。
   * 如果 activeTask 的 watch 因时序问题未能更新 phase，这里兜底确保 phase 切换。
   */
  watch(completedTasks, (tasks) => {
    if (!currentTaskId.value) return
    if (phase.value !== 'dispatching') return // 仅在 dispatching 阶段兜底
    const completed = tasks.find(t => t.taskId === currentTaskId.value)
    if (!completed) return
    if (completed.status === 'done') {
      phase.value = 'done'
    } else if (completed.status === 'cancelled') {
      phase.value = 'cancelled'
    } else if (completed.status === 'failed') {
      phase.value = 'done'
    }
  }, { deep: true })

  // ==================== 取消分发 ====================
  async function cancelDispatch() {
    if (!currentTaskId.value) return
    await cancelTask(currentTaskId.value)
    // SSE cancelled 事件会触发 phase 更新
  }

  // ==================== 后台继续 ====================
  const canBackground = computed(() => phase.value === 'dispatching')

  function backgroundContinue() {
    phase.value = 'idle'
    progressMatrix.value = {}
    instanceMeta.value = {}
    files.value = []
    currentTaskId.value = null
  }

  // ==================== 重置 ====================
  function resetToIdle() {
    phase.value = 'idle'
    progressMatrix.value = {}
    instanceMeta.value = {}
    files.value = []
    currentTaskId.value = null
  }

  // ==================== 失败重试 ====================
  // 重新暂存失败的文件 + 重新提交分发（目标收窄单实例）
  async function retryInstance(instId: string) {
    const cells = progressMatrix.value[instId]
    if (!cells) return

    // 找出该实例失败的对象
    const failedKeys = Object.keys(cells).filter(k => cells[k]?.status === 'failed')
    if (!failedKeys.length) return

    // 从 files 中找出对应的原始文件（按 objectKey 匹配）
    const failedFiles = files.value.filter(f => failedKeys.includes(f.objectKey))
    // 暂存文件可能在后台继续后已被清空，或正常完成分发后原始 File 对象仍可用
    if (!failedFiles.length) {
      toast.add({ title: '无法重试', description: '原始文件已不可用，请重新添加文件', color: 'error' })
      return
    }

    phase.value = 'staging'
    stagingCancelled = false
    stagingAbortControllers = []

    // 重新暂存失败文件
    const stagedFiles: { fileId: string; objectKey: string }[] = []
    let hasError = false
    for (const f of failedFiles) {
      f.status = 'uploading'
      f.progress = 0
      if (stagingCancelled) return
      try {
        await stageOneFile(f)
        if (f.fileId) stagedFiles.push({ fileId: f.fileId, objectKey: f.objectKey })
      } catch {
        hasError = true
      }
    }
    if (stagingCancelled) return
    if (!stagedFiles.length) {
      phase.value = 'idle'
      toast.add({ title: '重试暂存失败', description: '没有文件暂存成功', color: 'error' })
      return
    }
    if (hasError) {
      toast.add({ title: '部分文件重试暂存失败', color: 'warning' })
    }

    // 收窄单实例重新提交分发
    const targetBucket = instanceMeta.value[instId]?.bucket
    if (!targetBucket) {
      phase.value = 'idle'
      toast.add({ title: '重试失败', description: '缺少目标 bucket', color: 'error' })
      return
    }
    const targets = [{ instanceId: instId, bucket: targetBucket }]

    // 重置该实例的进度矩阵（重新赋值以触发响应式）
    const nextMatrix = { ...progressMatrix.value }
    nextMatrix[instId] = {}
    for (const f of stagedFiles) {
      nextMatrix[instId]![f.objectKey] = { status: 'pending' }
    }
    progressMatrix.value = nextMatrix
    // taskSummary 为派生 computed，自动从 progressMatrix 重算（重试的 pending 重新计入 total）

    phase.value = 'dispatching'
    try {
      const res = await $fetch<{ taskId: string }>('/api/dispatch', {
        method: 'POST',
        body: { files: stagedFiles, targets, prefix: prefix.value || '' },
      })
      currentTaskId.value = res.taskId
      await subscribeTask(res.taskId)
    } catch (e: unknown) {
      const err = e as { data?: { message?: string }; message?: string }
      toast.add({ title: '重试分发失败', description: err?.data?.message || err?.message || '未知错误', color: 'error' })
      phase.value = 'done'
    }
  }

  // ==================== 进度卡片显示控制 ====================
  const showProgress = computed(() =>
    (phase.value === 'staging'
      || phase.value === 'dispatching'
      || phase.value === 'done'
      || phase.value === 'cancelled'),
  )

  /** 分发阶段用于展示的实例列表（含名字、bucket） */
  const progressInstanceList = computed(() => {
    return Object.keys(progressMatrix.value).map(id => ({
      id,
      name: instanceMeta.value[id]?.instanceName || findInstance(id)?.name || id,
      bucket: instanceMeta.value[id]?.bucket || '',
    }))
  })

  function getInstanceProgress(instId: string) {
    const cells = progressMatrix.value[instId]
    if (!cells) return { completed: 0, total: 0, failed: 0, success: 0 }
    const all = Object.values(cells)
    return {
      completed: all.filter(c => c.status === 'success' || c.status === 'failed').length,
      total: all.length,
      failed: all.filter(c => c.status === 'failed').length,
      success: all.filter(c => c.status === 'success').length,
    }
  }

  function getOverallProgress(): number {
    if (!taskSummary.value) return 0
    const s = taskSummary.value
    const done = s.success + s.failed + s.skipped
    return s.total > 0 ? Math.round((done / s.total) * 100) : 0
  }

  const phaseLabel = computed(() => {
    switch (phase.value) {
      case 'staging': return '暂存中'
      case 'dispatching': return '分发中'
      case 'done': return taskSummary.value?.failed ? '已完成（有失败）' : '已完成'
      case 'cancelled': return '已取消'
      default: return ''
    }
  })

  // 暂存进度总览
  const stagingOverall = computed(() => {
    const uploading = files.value.filter(f => f.status === 'uploading' || f.status === 'done')
    if (!uploading.length) return { percent: 0, done: 0, total: 0 }
    const done = files.value.filter(f => f.status === 'done').length
    const sum = files.value.reduce((s, f) => {
      if (f.status === 'uploading' || f.status === 'done') return s + f.progress
      return s
    }, 0)
    return {
      percent: Math.round(sum / uploading.length),
      done,
      total: uploading.length,
    }
  })

  // 组件卸载时中断暂存（XHR 离开则中断）
  onBeforeUnmount(() => {
    if (phase.value === 'staging') {
      for (const ac of stagingAbortControllers) ac.abort()
    }
  })

  return {
    // 实例分组数据
    groupsData,
    groupsPending,
    groupsError,
    refresh,
    treeItems,
    findGroupById,
    findInstanceById,
    onInstanceNodeClick,
    showGroupBucketRow,

    // 目标选择
    selectedInstances,
    instanceBuckets,
    bucketsCache,
    bucketLoading,
    bucketError,
    loadBuckets,
    getBuckets,
    reloadBuckets,
    toggleInstance,
    isGroupAllSelected,
    isGroupPartialSelected,
    toggleGroup,
    getGroupCommonBuckets,
    applyGroupBucket,
    getAllCommonBuckets,
    applyBucketToAll,
    commonBucketValue,
    findGroupByInstanceId,
    selectedInstancesList,
    prefix,

    // 文件选择
    files,
    fileInput,
    folderInput,
    onFilesSelected,
    onFolderSelected,
    removeFile,
    fileGroups,
    folderExpanded,
    readyCount,

    // 分发状态机
    phase,
    progressMatrix,
    instanceMeta,
    taskSummary,
    progressExpanded,
    currentTaskId,

    // 分发操作
    startDispatch,
    cancelStaging,
    cancelDispatch,
    backgroundContinue,
    resetToIdle,
    retryInstance,

    // computed
    canSubmit,
    canBackground,
    showProgress,
    progressInstanceList,
    phaseLabel,
    stagingOverall,

    // 工具函数
    getInstanceProgress,
    getOverallProgress,
    formatSize,
    fileIcon,
  }
}

// ==================== provide/inject 注入键 ====================

export const DISPATCH_KEY: InjectionKey<DispatchComposable> = Symbol('dispatch')

/** 在 index.vue 中调用，提供 composable 给子组件 */
export function provideDispatch() {
  const dispatch = useDispatch()
  provide(DISPATCH_KEY, dispatch)
  return dispatch
}

/** 在子组件中调用，获取注入的 composable */
export function useInjectDispatch(): DispatchComposable {
  const dispatch = inject(DISPATCH_KEY)
  if (!dispatch) {
    throw new Error('useInjectDispatch() must be used within a component that has providedDispatch() in an ancestor')
  }
  return dispatch
}
