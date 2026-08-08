/** 任务类型 */
export type TaskType = 'dispatch' | 'copy' | 'move' | 'upload'

/** 任务状态 */
export type TaskStatus = 'queued' | 'running' | 'done' | 'cancelled' | 'failed'

/** 文件级结果 */
export interface FileResult {
  status: 'success' | 'failed' | 'running' | 'pending' | 'skipped'
  duration?: number
  error?: string
}

/** 实例级进度（dispatch 专属） */
export interface InstanceProgress {
  instanceId: string
  instanceName: string
  bucket: string
  results: Record<string, FileResult> // objectKey -> result
}

/** 扁平文件进度（copy/move/upload 通用） */
export interface FlatFileProgress {
  results: Record<string, FileResult> // objectKey -> result
}

/** 任务摘要 */
export interface TaskSummary {
  total: number
  success: number
  failed: number
  skipped: number
}

/** 任务描述信息（用于任务查看器展示） */
export interface TaskDescription {
  type: TaskType
  label: string // 如 "分发 -> 3 个实例"、"复制 5 个对象"
  detail?: string // 如 "A/bucket-a -> A/bucket-b"
}

/** 任务状态快照（用于 SSE 重连恢复 + 任务查看器） */
export interface TaskState {
  taskId: string
  type: TaskType
  status: TaskStatus
  createdAt: number
  completedAt?: number
  description: TaskDescription
  summary: TaskSummary | null
  instanceProgress?: InstanceProgress[] // dispatch 专属
  fileProgress?: FlatFileProgress // copy/move/upload 专属
  currentPhase?: string // move 的 'copying' | 'deleting'
  queuePosition?: number // queued 时有意义
  viewed?: boolean // 是否已被用户查看（角标用）
}

/** SSE 事件类型 */
export type TaskEvent =
  | { event: 'queued'; data: { taskId: string; queuePosition: number } }
  | { event: 'start'; data: { taskId: string } }
  | { event: 'progress'; data: { taskId: string; objectKey: string; result: FileResult; instanceId?: string } }
  | { event: 'phase'; data: { taskId: string; phase: string } }
  | { event: 'complete'; data: { taskId: string; summary: TaskSummary } }
  | { event: 'cancelled'; data: { taskId: string; summary: TaskSummary } }
  | { event: 'error'; data: { taskId: string; message: string } }

/** 任务负载（各执行器自己的参数） */
export interface TaskPayload {
  // dispatch
  files?: { fileId: string; objectKey: string }[]
  targets?: { instanceId: string; bucket: string }[]
  prefix?: string
  // copy/move
  sourceInstanceId?: string
  sourceBucket?: string
  sourcePrefix?: string
  keys?: string[]
  prefixes?: string[]
  targetInstanceId?: string
  targetBucket?: string
  targetPrefix?: string
  // upload
  instanceId?: string
  bucket?: string
}
