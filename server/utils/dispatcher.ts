import type {
  DispatchResult,
  DispatchTask,
  MinioInstance,
} from '../types'
import { uploadJson } from './minio'

/**
 * 分发执行器
 *
 * - 内存任务注册表：taskId → DispatchTask + 事件订阅者列表
 * - 实例维度并发（默认 5），每个实例内文件串行上传
 * - 每个文件完成后通知所有订阅者（SSE）
 * - 前端通过 GET /api/dispatch/events?taskId=xxx 订阅进度
 */

/** 并发数，可通过 DISPATCH_CONCURRENCY 环境变量配置 */
const CONCURRENCY = Number(process.env.DISPATCH_CONCURRENCY) || 5

// ---------- 任务注册表 ----------

interface TaskEntry {
  task: DispatchTask
  /** 事件订阅者回调列表（SSE 连接） */
  subscribers: Array<(event: { type: string; taskId: string; result?: DispatchResult; summary?: { total: number; success: number; failed: number } }) => void>
}

const taskRegistry = new Map<string, TaskEntry>()

/** 注册任务到内存表 */
export function registerTask(task: DispatchTask): void {
  taskRegistry.set(task.id, { task, subscribers: [] })
}

/** 订阅任务事件（SSE 连接调用），返回取消订阅函数 */
export function subscribeTask(
  taskId: string,
  callback: TaskEntry['subscribers'][number],
): () => void {
  const entry = taskRegistry.get(taskId)
  if (!entry) return () => {}

  // 如果任务已完成，立即推送 complete 事件
  if (entry.task.status === 'done') {
    const results = entry.task.results
    const summary = {
      total: results.length,
      success: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length,
    }
    callback({ type: 'complete', taskId, summary })
    return () => {}
  }

  entry.subscribers.push(callback)
  return () => {
    const idx = entry.subscribers.indexOf(callback)
    if (idx >= 0) entry.subscribers.splice(idx, 1)
  }
}

/** 通知任务的所有订阅者 */
function notify(taskId: string, event: { type: string; taskId: string; result?: DispatchResult; summary?: { total: number; success: number; failed: number } }): void {
  const entry = taskRegistry.get(taskId)
  if (!entry) return
  for (const sub of entry.subscribers) {
    try { sub(event) } catch { /* 忽略已关闭的连接 */ }
  }
}

/** 获取任务（用于查询状态） */
export function getTask(taskId: string): DispatchTask | null {
  return taskRegistry.get(taskId)?.task ?? null
}

// ---------- 分发执行 ----------

/**
 * 执行分发任务。
 * 实例维度并发（CONCURRENCY），每个实例内文件串行上传。
 */
export async function executeDispatch(task: DispatchTask): Promise<void> {
  const entry = taskRegistry.get(task.id)
  if (!entry) return

  task.status = 'running'
  notify(task.id, { type: 'start', taskId: task.id })

  const instances = task.resolvedInstances
  const files = task.request.files
  const bucket = task.request.bucket

  // 信号量并发控制
  const queue = [...instances]
  const running: Promise<void>[] = []

  while (queue.length > 0 || running.length > 0) {
    while (running.length < CONCURRENCY && queue.length > 0) {
      const instance = queue.shift()!
      const p = processInstance(task.id, instance, files, bucket)
      running.push(p)
      p.finally(() => {
        const idx = running.indexOf(p)
        if (idx >= 0) running.splice(idx, 1)
      })
    }
    if (running.length > 0) {
      await Promise.race(running)
    }
  }

  // 全部完成
  task.status = 'done'
  task.finishedAt = new Date().toISOString()
  const summary = {
    total: task.results.length,
    success: task.results.filter(r => r.status === 'success').length,
    failed: task.results.filter(r => r.status === 'failed').length,
  }
  notify(task.id, { type: 'complete', taskId: task.id, summary })

  // 延迟清理任务注册表（保留 60s 供迟到的 SSE 连接查询）
  setTimeout(() => taskRegistry.delete(task.id), 60_000)
}

/** 处理单个实例：遍历文件，逐个上传 */
async function processInstance(
  taskId: string,
  instance: MinioInstance,
  files: { name: string; content: string }[],
  bucketOverride: string | undefined,
): Promise<void> {
  const targetBucket = bucketOverride || instance.bucket
  const task = taskRegistry.get(taskId)!.task

  for (const file of files) {
    const result: DispatchResult = {
      groupId: instance.groupId,
      instanceId: instance.id,
      instanceName: instance.name,
      fileName: file.name,
      status: 'success',
    }

    // 没有 bucket：直接失败
    if (!targetBucket) {
      result.status = 'failed'
      result.error = '未指定 bucket'
      task.results.push(result)
      notify(taskId, { type: 'progress', taskId, result })
      continue
    }

    const start = Date.now()
    try {
      await uploadJson(instance, targetBucket, file.name, file.content)
      result.duration = Date.now() - start
      task.results.push(result)
      notify(taskId, { type: 'progress', taskId, result })
    }
    catch (e: any) {
      result.status = 'failed'
      result.error = e?.message || '上传失败'
      result.duration = Date.now() - start
      task.results.push(result)
      notify(taskId, { type: 'progress', taskId, result })
    }
  }
}
