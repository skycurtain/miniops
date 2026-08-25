import { randomUUID } from 'node:crypto'
import type {
  TaskType,
  TaskStatus,
  TaskState,
  TaskEvent,
  TaskDescription,
  TaskSummary,
  InstanceProgress,
  FlatFileProgress,
  TaskPayload,
} from '#shared/schemas/task'

/** 任务执行器接口 */
export interface TaskExecutor {
  execute(
    task: Task,
    emit: (event: TaskEvent) => void,
    isCancelled: () => boolean,
  ): Promise<void>
}

/** 任务内部结构 */
export interface Task {
  taskId: string
  type: TaskType
  description: TaskDescription
  status: TaskStatus
  createdAt: number
  completedAt?: number
  executor: TaskExecutor | null
  cancelRequested: boolean
  viewed: boolean
  payload: TaskPayload
  summary: TaskSummary | null
  instanceProgress: InstanceProgress[]
  fileProgress: FlatFileProgress
  currentPhase?: string
  subscribers: Set<(event: TaskEvent) => void>
}

const RETENTION_SECONDS = Number(process.env.TASK_RETENTION_SECONDS) || 1800

const tasks = new Map<string, Task>()
const queue: Task[] = []
let running: Task | null = null
let processing = false

/** 创建任务，返回 taskId */
export function createTask(
  type: TaskType,
  description: TaskDescription,
  executor: TaskExecutor,
  payload: TaskPayload = {},
): string {
  const taskId = `task-${randomUUID()}`
  const task: Task = {
    taskId,
    type,
    description,
    status: 'queued',
    createdAt: Date.now(),
    executor,
    cancelRequested: false,
    viewed: false,
    payload,
    summary: null,
    instanceProgress: [],
    fileProgress: { results: {} },
    subscribers: new Set(),
  }

  tasks.set(taskId, task)

  // 如果没有正在执行的任务，直接开始；否则入队
  if (!running) {
    void processQueue(task)
  } else {
    queue.push(task)
    const queuePosition = queue.length
    emitToSubscribers(task, {
      event: 'queued',
      data: { taskId, queuePosition },
    })
  }

  return taskId
}

/** 订阅任务事件（SSE），返回取消订阅函数。订阅时立即推送当前状态快照。 */
export function subscribe(taskId: string, callback: (event: TaskEvent) => void): () => void {
  const task = tasks.get(taskId)
  if (!task) {
    // 任务不存在（可能已过期），推送 error
    callback({ event: 'error', data: { taskId, message: '任务不存在或已过期' } })
    return () => {}
  }

  task.subscribers.add(callback)

  // 立即推送当前状态快照
  const state = getTaskState(taskId)
  if (state) {
    if (state.status === 'queued' && state.queuePosition !== undefined) {
      callback({ event: 'queued', data: { taskId, queuePosition: state.queuePosition } })
    } else if (state.status === 'running') {
      callback({ event: 'start', data: { taskId } })
      // 推送已有进度
      if (state.instanceProgress) {
        for (const inst of state.instanceProgress) {
          for (const [objectKey, result] of Object.entries(inst.results)) {
            if (result.status !== 'pending') {
              callback({
                event: 'progress',
                data: { taskId, objectKey, result, instanceId: inst.instanceId },
              })
            }
          }
        }
      }
      if (state.fileProgress) {
        for (const [objectKey, result] of Object.entries(state.fileProgress.results)) {
          if (result.status !== 'pending') {
            callback({ event: 'progress', data: { taskId, objectKey, result } })
          }
        }
      }
    }
  }

  return () => {
    task.subscribers.delete(callback)
  }
}

/** 获取任务状态快照 */
export function getTaskState(taskId: string): TaskState | null {
  const task = tasks.get(taskId)
  if (!task) return null

  const state: TaskState = {
    taskId: task.taskId,
    type: task.type,
    status: task.status,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
    description: task.description,
    summary: task.summary,
    viewed: task.viewed,
  }

  if (task.instanceProgress.length > 0) {
    state.instanceProgress = task.instanceProgress
  }
  if (Object.keys(task.fileProgress.results).length > 0) {
    state.fileProgress = task.fileProgress
  }
  if (task.currentPhase) {
    state.currentPhase = task.currentPhase
  }
  if (task.status === 'queued') {
    state.queuePosition = queue.indexOf(task) + 1
  }

  return state
}

/** 获取任务列表（任务查看器"最近完成"用） */
export function listTasks(statuses?: TaskStatus[], limit = 10): TaskState[] {
  const result: Task[] = []

  for (const task of tasks.values()) {
    if (!statuses || statuses.includes(task.status)) {
      if (task.status === 'done' || task.status === 'cancelled' || task.status === 'failed') {
        result.push(task)
      }
    }
  }

  result.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))

  return result.slice(0, limit).map((t) => getTaskState(t.taskId)!)
}

/** 取消任务 */
export function cancelTask(taskId: string): boolean {
  const task = tasks.get(taskId)
  if (!task) return false

  if (task.status === 'queued') {
    // 排队中取消：直接从 Map 移除（不进入"最近完成"），从队列移除
    // 不 emit cancelled 事件：排队取消的任务不应出现在最近完成中
    const idx = queue.indexOf(task)
    if (idx >= 0) queue.splice(idx, 1)
    tasks.delete(taskId)
    return true
  }

  if (task.status === 'running') {
    // 执行中取消：设置标志，执行器在检查点停止，终态为 cancelled（进入"最近完成"）
    task.cancelRequested = true
    return true
  }

  return false
}

/** 批量标记已查看 */
export function markViewed(taskIds: string[]): void {
  for (const taskId of taskIds) {
    const task = tasks.get(taskId)
    if (task) {
      task.viewed = true
    }
  }
}

/** 获取当前活跃任务（执行中 + 排队中） */
export function getActiveTasks(): TaskState[] {
  const result: TaskState[] = []
  if (running) {
    result.push(getTaskState(running.taskId)!)
  }
  for (const task of queue) {
    result.push(getTaskState(task.taskId)!)
  }
  return result
}

// ===== 内部：队列调度 =====

async function processQueue(initialTask: Task): Promise<void> {
  if (processing) return
  processing = true

  let task: Task | undefined = initialTask

  try {
    while (task) {
      running = task
      task.status = 'running'
      emitToSubscribers(task, { event: 'start', data: { taskId: task.taskId } })

      try {
        await task!.executor?.execute(task!, makeEmitter(task!), () => task!.cancelRequested)
      } catch (err) {
        // 执行器抛出未捕获错误
        task.status = 'failed'
      }

      // 确定终态
      if (task.status === 'running') {
        task.status = task.cancelRequested ? 'cancelled' : 'done'
      }
      task.completedAt = Date.now()
      task.executor = null

      // 推送终态事件
      const summary = task.summary || { total: 0, success: 0, failed: 0, skipped: 0 }
      if (task.status === 'done') {
        emitToSubscribers(task, { event: 'complete', data: { taskId: task.taskId, summary } })
      } else if (task.status === 'cancelled') {
        emitToSubscribers(task, { event: 'cancelled', data: { taskId: task.taskId, summary } })
      } else {
        emitToSubscribers(task, { event: 'error', data: { taskId: task.taskId, message: '任务执行失败' } })
      }

      // 定时清理
      scheduleCleanup(task.taskId)

      // 取下一个
      running = null
      task = queue.shift()
    }
  } finally {
    processing = false
  }
}

function makeEmitter(task: Task): (event: TaskEvent) => void {
  return (event: TaskEvent) => {
    emitToSubscribers(task, event)
  }
}

function emitToSubscribers(task: Task, event: TaskEvent) {
  for (const cb of task.subscribers) {
    try {
      cb(event)
    } catch {
      // 订阅者连接断开，忽略
    }
  }
}

function scheduleCleanup(taskId: string) {
  setTimeout(() => {
    tasks.delete(taskId)
  }, RETENTION_SECONDS * 1000)
}
