import type { TaskState, TaskStatus, TaskSummary, FileResult } from '#shared/schemas/task'

/**
 * 任务管理 composable（跨组件单例）。
 *
 * 与 use-connectivity 的组件级模式不同：这里用 `useState` 把任务状态挂到
 * Nuxt 的全局单例上，多个组件共享同一份 activeTasks / queueTasks / completedTasks。
 *
 * 必须在 setup 顶层调用（内部使用了 useState / useToast）。
 *
 * SSE 连接（EventSource）与任务执行解绑：断线不中断任务，重连可恢复进度。
 * 支持多任务并行订阅（每个任务一个 EventSource）。
 */

// ===== 客户端连接实例（模块级单例，仅客户端使用）=====
// EventSource 不可序列化，不放进 useState；放在模块级 Map，客户端单例共享。
const eventSources = new Map<string, { es: EventSource, disposed: boolean }>()
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** progress 事件载荷 */
interface ProgressData {
  taskId: string
  objectKey: string
  result: FileResult
  instanceId?: string
}

export function useTaskManager() {
  const activeTasks = useState<TaskState[]>('task-active', () => [])
  const queueTasks = useState<TaskState[]>('task-queue', () => [])
  const completedTasks = useState<TaskState[]>('task-completed', () => [])

  const toast = useToast()

  // ===== 内部：连接管理（按 taskId） =====

  function clearReconnect(taskId: string) {
    const timer = reconnectTimers.get(taskId)
    if (timer) {
      clearTimeout(timer)
      reconnectTimers.delete(taskId)
    }
  }

  function closeEventSource(taskId: string) {
    const entry = eventSources.get(taskId)
    if (entry) {
      entry.es.close()
      eventSources.delete(taskId)
    }
  }

  function cleanupConnection(taskId: string) {
    clearReconnect(taskId)
    closeEventSource(taskId)
  }

  // ===== 内部：activeTasks 数组操作 =====

  function upsertActiveTask(state: TaskState) {
    const idx = activeTasks.value.findIndex(t => t.taskId === state.taskId)
    if (idx >= 0) {
      activeTasks.value[idx] = state
    } else {
      activeTasks.value = [...activeTasks.value, state]
    }
  }

  function updateActiveTask(taskId: string, updater: (t: TaskState) => TaskState) {
    const idx = activeTasks.value.findIndex(t => t.taskId === taskId)
    if (idx >= 0) {
      const next = activeTasks.value.slice()
      next[idx] = updater(next[idx]!)
      activeTasks.value = next
    }
  }

  function removeActiveTask(taskId: string) {
    activeTasks.value = activeTasks.value.filter(t => t.taskId !== taskId)
  }

  // ===== 内部：进度合并 =====

  /** 将一条 progress 事件合并进 TaskState，返回新对象以保证响应式 */
  function applyProgress(state: TaskState, data: ProgressData): TaskState {
    const next: TaskState = { ...state }

    if (data.instanceId) {
      // dispatch 专属：按实例分组
      const list = state.instanceProgress ?? []
      const idx = list.findIndex(i => i.instanceId === data.instanceId)
      if (idx >= 0) {
        const inst = list[idx]!
        next.instanceProgress = list.slice()
        next.instanceProgress[idx] = {
          ...inst,
          results: { ...inst.results, [data.objectKey]: data.result },
        }
      }
      else {
        // 快照里尚未出现该实例（执行器未预初始化），补一个最小条目
        next.instanceProgress = [
          ...list,
          {
            instanceId: data.instanceId,
            instanceName: '',
            bucket: '',
            results: { [data.objectKey]: data.result },
          },
        ]
      }
    }
    else {
      // copy/move/upload 通用：扁平文件进度
      const results = state.fileProgress?.results ?? {}
      next.fileProgress = {
        results: { ...results, [data.objectKey]: data.result },
      }
    }

    return next
  }

  // ===== 内部：终态归档 =====

  /**
   * 把任务移入 completedTasks，并从 activeTasks / queueTasks 清理。
   * 幂等：若该任务已归档且不再持有 active，则跳过。
   */
  function finalize(
    taskId: string,
    status: TaskStatus,
    summary?: TaskSummary | null,
    base?: TaskState,
  ) {
    const source: TaskState | null
      = base
        ?? activeTasks.value.find(t => t.taskId === taskId)
        ?? queueTasks.value.find(t => t.taskId === taskId)
        ?? null

    if (source) {
      const finalState: TaskState = {
        ...source,
        status,
        summary: summary ?? source.summary ?? null,
        completedAt: source.completedAt ?? Date.now(),
      }
      // 去重后置顶，保留最近 20 条避免无限增长
      completedTasks.value = [
        finalState,
        ...completedTasks.value.filter(t => t.taskId !== taskId),
      ].slice(0, 20)
    }

    // 先更新 status 让监听 activeTasks 的组件能感知终态，再移除
    updateActiveTask(taskId, t => ({
      ...t,
      status,
      summary: summary ?? t.summary ?? null,
      completedAt: source?.completedAt ?? Date.now(),
    }))
    nextTick(() => removeActiveTask(taskId))
    queueTasks.value = queueTasks.value.filter(t => t.taskId !== taskId)
  }

  // ===== 内部：SSE 接线 =====

  function scheduleReconnect(taskId: string) {
    clearReconnect(taskId)
    reconnectTimers.set(taskId, setTimeout(() => {
      reconnectTimers.delete(taskId)
      void subscribeTask(taskId)
    }, 5000))
  }

  function attachSse(taskId: string) {
    cleanupConnection(taskId)

    const es = new EventSource(`/api/tasks/${taskId}/events`)
    eventSources.set(taskId, { es, disposed: false })
    const entry = eventSources.get(taskId)!

    const dispose = () => {
      if (entry.disposed) return
      entry.disposed = true
      closeEventSource(taskId)
      clearReconnect(taskId)
    }

    es.addEventListener('queued', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { taskId: string, queuePosition: number }
      // queued 任务在 queueTasks 里更新
      queueTasks.value = queueTasks.value.map(t =>
        t.taskId === taskId
          ? { ...t, status: 'queued' as const, queuePosition: data.queuePosition }
          : t,
      )
    })

    es.addEventListener('start', () => {
      // 从 queueTasks 移到 activeTasks
      const queued = queueTasks.value.find(t => t.taskId === taskId)
      if (queued) {
        upsertActiveTask({ ...queued, status: 'running', queuePosition: undefined })
      } else {
        // 已在 activeTasks 里（重连场景）
        updateActiveTask(taskId, t => ({
          ...t,
          status: 'running',
          queuePosition: undefined,
        }))
      }
      // 开始执行 -> 不再排队
      queueTasks.value = queueTasks.value.filter(t => t.taskId !== taskId)
    })

    es.addEventListener('progress', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as ProgressData
      updateActiveTask(taskId, t => applyProgress(t, data))
    })

    es.addEventListener('phase', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { taskId: string, phase: string }
      updateActiveTask(taskId, t => ({ ...t, currentPhase: data.phase }))
    })

    es.addEventListener('complete', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { taskId: string, summary: TaskSummary }
      finalize(taskId, 'done', data.summary)
      dispose()
    })

    es.addEventListener('cancelled', (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { taskId: string, summary: TaskSummary }
      finalize(taskId, 'cancelled', data.summary)
      dispose()
    })

    // 注意：服务端业务 'error' 事件与网络断开的 onerror 都走这里。
    // 服务端发的 error 是 MessageEvent，e.data 为 JSON 字符串；网络断开是普通 Event，无 data。
    es.addEventListener('error', (e: Event) => {
      const me = e as MessageEvent
      if (typeof me.data === 'string') {
        // 服务端推送的任务失败终态
        let message = '任务执行失败'
        try {
          const parsed = JSON.parse(me.data) as { taskId: string, message?: string }
          message = parsed.message || message
        }
        catch {
          // JSON 解析失败用默认消息
        }
        finalize(taskId, 'failed', null)
        toast.add({ title: '任务失败', description: message, color: 'error' })
        dispose()
      }
      else {
        // 网络断开 -> 5 秒后重连（先阻止 EventSource 默认自动重连）
        if (entry.disposed) return
        dispose()
        scheduleReconnect(taskId)
      }
    })
  }

  // ===== 对外方法 =====

  /**
   * 订阅任务进度（SSE）。
   * 先拉状态快照恢复进度，再建立 EventSource。
   * 不影响其他已有任务订阅。
   */
  async function subscribeTask(taskId: string) {
    if (import.meta.server)
      return

    // 1. 拉取状态快照（重连恢复用）
    try {
      const state = await $fetch<TaskState>(`/api/tasks/${taskId}/state`)

      // 已是终态 -> 直接归档，无需 SSE
      if (state.status === 'done' || state.status === 'cancelled' || state.status === 'failed') {
        finalize(taskId, state.status, state.summary, state)
        return
      }

      if (state.status === 'queued') {
        // queued 任务只进队列列表，不进 activeTasks
        queueTasks.value = [
          ...queueTasks.value.filter(t => t.taskId !== taskId),
          state,
        ]
      }
      else if (state.status === 'running') {
        // running 任务才进 activeTasks
        upsertActiveTask(state)
        queueTasks.value = queueTasks.value.filter(t => t.taskId !== taskId)
      }
    }
    catch {
      // 快照拉取失败（可能已过期），仍尝试建立 SSE 由服务端兜底
    }

    // 2. 建立 EventSource（不影响其他任务的 SSE 连接）
    attachSse(taskId)
  }

  /** 取消任务 */
  async function cancelTask(taskId: string) {
    try {
      await $fetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' })
      const wasQueued = queueTasks.value.some(t => t.taskId === taskId)
      // queued 取消：后端直接删除任务，乐观从队列移除
      queueTasks.value = queueTasks.value.filter(t => t.taskId !== taskId)
      if (wasQueued) {
        // 排队取消后端不 emit cancelled，本地归档并关掉 SSE
        finalize(taskId, 'cancelled', null)
        cleanupConnection(taskId)
      }
      // running 取消：保留 SSE，等 cancelled 事件（含 summary/终态 fileProgress）再归档
    }
    catch (e) {
      console.error('[cancelTask] 取消失败:', taskId, e)
      toast.add({ title: '取消任务失败', color: 'error' })
    }
  }

  /** 拉取最近完成任务（打开任务查看器时调用） */
  async function fetchCompleted() {
    try {
      const tasks = await $fetch<TaskState[]>('/api/tasks', {
        query: { status: 'done,failed,cancelled', limit: 10 },
      })
      completedTasks.value = tasks
    }
    catch {
      toast.add({ title: '加载最近任务失败', color: 'error' })
    }
  }

  /** 拉取活跃任务（执行中 + 排队中），返回任务列表供调用方重建订阅 */
  async function fetchActive(): Promise<TaskState[]> {
    try {
      const tasks = await $fetch<TaskState[]>('/api/tasks', { query: { active: 1 } })
      queueTasks.value = tasks.filter(t => t.status === 'queued')

      const running = tasks.filter(t => t.status === 'running')
      // 合并服务端的 running 任务到 activeTasks（不覆盖已有订阅的）
      const existingIds = new Set(activeTasks.value.map(t => t.taskId))
      for (const task of running) {
        if (!existingIds.has(task.taskId)) {
          upsertActiveTask(task)
        }
      }
      return tasks
    }
    catch {
      toast.add({ title: '加载活跃任务失败', color: 'error' })
      return []
    }
  }

  /** 批量标记已查看（打开弹窗时调用，角标用） */
  async function markViewed(taskIds: string[]) {
    if (!taskIds.length)
      return
    try {
      await $fetch('/api/tasks/viewed', {
        method: 'POST',
        body: { taskIds },
      })
      // 本地同步 viewed，避免角标闪烁
      const ids = new Set(taskIds)
      completedTasks.value = completedTasks.value.map(t =>
        ids.has(t.taskId) ? { ...t, viewed: true } : t,
      )
    }
    catch {
      // 标记已查看失败不阻塞交互，静默
    }
  }

  return {
    activeTasks,
    queueTasks,
    completedTasks,
    subscribeTask,
    cancelTask,
    fetchCompleted,
    fetchActive,
    markViewed,
  }
}
