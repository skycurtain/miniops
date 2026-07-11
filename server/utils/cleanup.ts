import type {
  CleanupResult,
  CleanupTask,
  MinioInstance,
} from '../types'
import { deleteObjects, deleteByPrefixes, listObjects } from './minio'

/**
 * 清理执行器
 *
 * - 内存任务注册表：taskId -> CleanupTask + 事件订阅者列表
 * - 实例维度并发（默认 5），每个实例内串行删除
 * - 每个对象/前缀删除完成后通知所有订阅者（SSE）
 * - 前端通过 GET /api/cleanup/events?taskId=xxx 订阅进度
 *
 * 两种删除模式：
 * A. 精确勾选模式（keys/prefixes 有值）：直接删 keys + prefixes
 * B. 按前缀全删模式（keys/prefixes 为空）：
 *    - recursive=true: deleteByPrefixes([prefix || ''])
 *    - recursive=false: listObjects(prefix, '/') -> 只删 Contents 的 key
 */

/** 并发数，可通过 CLEANUP_CONCURRENCY 环境变量配置 */
const CONCURRENCY = Number(process.env.CLEANUP_CONCURRENCY) || 5

/** 批量删除单批上限（S3 DeleteMultipleObjects 限制） */
const DELETE_BATCH_SIZE = 1000

// ---------- 任务注册表 ----------

interface TaskEntry {
  task: CleanupTask
  /** 事件订阅者回调列表（SSE 连接） */
  subscribers: Array<(event: { type: string; taskId: string; result?: CleanupResult; summary?: { total: number; success: number; failed: number } }) => void>
}

const taskRegistry = new Map<string, TaskEntry>()

/** 注册任务到内存表 */
export function registerCleanupTask(task: CleanupTask): void {
  taskRegistry.set(task.id, { task, subscribers: [] })
}

/** 订阅任务事件（SSE 连接调用），返回取消订阅函数 */
export function subscribeCleanupTask(
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
function notify(taskId: string, event: { type: string; taskId: string; result?: CleanupResult; summary?: { total: number; success: number; failed: number } }): void {
  const entry = taskRegistry.get(taskId)
  if (!entry) return
  for (const sub of entry.subscribers) {
    try { sub(event) } catch { /* 忽略已关闭的连接 */ }
  }
}

/** 获取任务（用于查询状态） */
export function getCleanupTask(taskId: string): CleanupTask | null {
  return taskRegistry.get(taskId)?.task ?? null
}

// ---------- 清理执行 ----------

/**
 * 执行清理任务。
 * 实例维度并发（CONCURRENCY），每个实例内串行删除。
 */
export async function executeCleanup(task: CleanupTask): Promise<void> {
  const entry = taskRegistry.get(task.id)
  if (!entry) return

  task.status = 'running'
  notify(task.id, { type: 'start', taskId: task.id })

  const instances = task.resolvedInstances
  const { bucket, keys, prefixes, prefix, recursive } = task.request

  // 信号量并发控制
  const queue = [...instances]
  const running: Promise<void>[] = []

  while (queue.length > 0 || running.length > 0) {
    while (running.length < CONCURRENCY && queue.length > 0) {
      const instance = queue.shift()!
      const p = processInstanceCleanup(task.id, instance, bucket, keys, prefixes, prefix, recursive)
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

/** 推送单个结果并记录 */
function pushResult(taskId: string, result: CleanupResult): void {
  const task = taskRegistry.get(taskId)!.task
  task.results.push(result)
  notify(taskId, { type: 'progress', taskId, result })
}

/**
 * 处理单个实例的清理。
 *
 * 两种模式：
 * A. 精确勾选模式（keys/prefixes 有值）：直接删 keys + prefixes
 * B. 按前缀全删模式（keys/prefixes 为空）：
 *    - recursive=true: deleteByPrefixes([prefix || ''])
 *    - recursive=false: listObjects(prefix, '/') -> 只删 Contents 的 key
 */
async function processInstanceCleanup(
  taskId: string,
  instance: MinioInstance,
  bucket: string,
  keys: string[] | undefined,
  prefixes: string[] | undefined,
  prefix: string | undefined,
  recursive: boolean | undefined,
): Promise<void> {
  // ---------- 模式 A：精确勾选 ----------

  // A1. 删除精确对象（分批 DELETE_BATCH_SIZE）
  if (keys?.length) {
    const start = Date.now()
    try {
      const allDeleted: string[] = []
      const allErrors: { key: string, error: string }[] = []
      for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
        const batch = keys.slice(i, i + DELETE_BATCH_SIZE)
        const result = await deleteObjects(instance, bucket, batch)
        allDeleted.push(...result.deleted)
        allErrors.push(...result.errors)
      }
      // 精确模式：每个 key 推一个 result
      const duration = Date.now() - start
      for (const key of keys) {
        const err = allErrors.find(e => e.key === key)
        pushResult(taskId, {
          instanceId: instance.id,
          instanceName: instance.name,
          target: key,
          targetType: 'object',
          status: err ? 'failed' : 'success',
          error: err?.error,
          duration,
        })
      }
    }
    catch (e: any) {
      // 整体异常：所有 key 标记失败
      const duration = Date.now() - start
      for (const key of keys) {
        pushResult(taskId, {
          instanceId: instance.id,
          instanceName: instance.name,
          target: key,
          targetType: 'object',
          status: 'failed',
          error: e?.message || '删除失败',
          duration,
        })
      }
    }
  }

  // A2. 删除文件夹前缀（逐个 deleteByPrefixes）
  if (prefixes?.length) {
    for (const pfx of prefixes) {
      const start = Date.now()
      const result: CleanupResult = {
        instanceId: instance.id,
        instanceName: instance.name,
        target: pfx,
        targetType: 'prefix',
        status: 'success',
      }
      try {
        const delResult = await deleteByPrefixes(instance, bucket, [pfx])
        result.deletedCount = delResult.deleted.length
        if (delResult.errors.length) {
          result.status = 'failed'
          result.error = delResult.errors[0]?.error
        }
        result.duration = Date.now() - start
      }
      catch (e: any) {
        result.status = 'failed'
        result.error = e?.message || '递归删除失败'
        result.duration = Date.now() - start
      }
      pushResult(taskId, result)
    }
  }

  // 精确模式到此结束
  if (keys?.length || prefixes?.length) return

  // ---------- 模式 B：按前缀全删 ----------

  const effectivePrefix = prefix || ''

  if (recursive) {
    // 递归删除：直接用 deleteByPrefixes
    const start = Date.now()
    const result: CleanupResult = {
      instanceId: instance.id,
      instanceName: instance.name,
      target: effectivePrefix || '/',
      targetType: 'prefix',
      status: 'success',
    }
    try {
      const delResult = await deleteByPrefixes(instance, bucket, [effectivePrefix])
      result.deletedCount = delResult.deleted.length
      if (delResult.errors.length) {
        result.status = 'failed'
        result.error = delResult.errors[0]?.error
      }
      result.duration = Date.now() - start
    }
    catch (e: any) {
      result.status = 'failed'
      result.error = e?.message || '递归删除失败'
      result.duration = Date.now() - start
    }
    pushResult(taskId, result)
  }
  else {
    // 非递归：listObjects(delimiter='/') -> 只删 Contents 的 key
    const start = Date.now()
    try {
      const allKeys: string[] = []
      let token: string | undefined
      do {
        const listResult = await listObjects(instance, bucket, effectivePrefix, '/', token)
        if (listResult.error) {
          pushResult(taskId, {
            instanceId: instance.id,
            instanceName: instance.name,
            target: effectivePrefix || '/',
            targetType: 'prefix',
            status: 'failed',
            error: `列出对象失败: ${listResult.error}`,
            duration: Date.now() - start,
          })
          return
        }
        allKeys.push(...listResult.objects.map(o => o.key))
        token = listResult.isTruncated ? listResult.continuationToken : undefined
      } while (token)

      // 分批删除
      const allDeleted: string[] = []
      const allErrors: { key: string, error: string }[] = []
      for (let i = 0; i < allKeys.length; i += DELETE_BATCH_SIZE) {
        const batch = allKeys.slice(i, i + DELETE_BATCH_SIZE)
        const delResult = await deleteObjects(instance, bucket, batch)
        allDeleted.push(...delResult.deleted)
        allErrors.push(...delResult.errors)
      }

      pushResult(taskId, {
        instanceId: instance.id,
        instanceName: instance.name,
        target: effectivePrefix || '/',
        targetType: 'prefix',
        status: allErrors.length ? 'failed' : 'success',
        deletedCount: allDeleted.length,
        error: allErrors[0]?.error,
        duration: Date.now() - start,
      })
    }
    catch (e: any) {
      pushResult(taskId, {
        instanceId: instance.id,
        instanceName: instance.name,
        target: effectivePrefix || '/',
        targetType: 'prefix',
        status: 'failed',
        error: e?.message || '删除失败',
        duration: Date.now() - start,
      })
    }
  }
}
