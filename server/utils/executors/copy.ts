import {
  copyObjectStream,
  collectObjectsByPrefixes,
  inferContentType,
  formatExecError,
} from '#server/utils/s3'
import type { TaskExecutor, Task } from '#server/utils/task-manager'
import type { FileResult, TaskSummary, TaskEvent } from '#shared/schemas/task'
import type { S3Instance } from '#shared/schemas/groups'

const TASK_DELAY_MS = Number(process.env.TASK_DELAY_MS) || 0

/** 复制/移动参数（API 层查找实例后传入，executor 不依赖 store.ts） */
export interface CopyParams {
  sourceInstance: S3Instance
  sourceBucket: string
  sourcePrefix: string
  keys: string[]
  prefixes: string[]
  targetInstance: S3Instance
  targetBucket: string
  targetPrefix: string
}

/**
 * 计算复制后的目标 key：源前缀剥离后拼接到目标前缀下。
 * 例：sourcePrefix='data/', key='data/a/b.txt', targetPrefix='backup'
 *     -> relativeKey='a/b.txt' -> targetKey='backup/a/b.txt'
 */
export function computeTargetKey(
  sourcePrefix: string,
  key: string,
  targetPrefix: string,
): string {
  const relativeKey =
    sourcePrefix && key.startsWith(sourcePrefix)
      ? key.slice(sourcePrefix.length)
      : key
  return targetPrefix
    ? `${targetPrefix.replace(/\/$/, '')}/${relativeKey}`
    : relativeKey
}

/** 从 fileProgress 统计摘要（pending 归入 skipped） */
function computeFileSummary(fileProgress: Task['fileProgress']): TaskSummary {
  const results = Object.values(fileProgress.results)
  return {
    total: results.length,
    success: results.filter(r => r.status === 'success').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped' || r.status === 'pending').length,
  }
}

/**
 * 复制阶段：收集 key + 逐个复制，更新 fileProgress 并发 progress 事件。
 * 被 CopyExecutor 和 MoveExecutor 复用。
 *
 * @returns 成功复制的 key 列表（供 move 的删除阶段使用）
 */
export async function copyObjectsPhase(
  task: Task,
  emit: (event: TaskEvent) => void,
  isCancelled: () => boolean,
  params: CopyParams,
): Promise<string[]> {
  // 1. 收集所有 key（keys 直接加入，prefixes 递归展开）
  const allKeys = new Set<string>(params.keys)
  for (const prefix of params.prefixes) {
    if (isCancelled()) return []
    const { keys, error } = await collectObjectsByPrefixes(
      params.sourceInstance,
      params.sourceBucket,
      [prefix],
    )
    if (error) throw new Error(error)
    for (const k of keys) allKeys.add(k)
  }

  // 初始化 fileProgress：所有 key 标记为 pending
  const keyArray = Array.from(allKeys)
  for (const key of keyArray) {
    task.fileProgress.results[key] = { status: 'pending' }
  }

  // 2. 逐文件复制（单文件失败不中断，继续下一个）
  const copiedKeys: string[] = []
  for (const key of keyArray) {
    if (isCancelled()) break

    // 标记进行中
    task.fileProgress.results[key] = { status: 'running' }
    emit({
      event: 'progress',
      data: { taskId: task.taskId, objectKey: key, result: { status: 'running' } },
    })

    const startTime = Date.now()
    try {
      const targetKey = computeTargetKey(
        params.sourcePrefix,
        key,
        params.targetPrefix,
      )
      const contentType = inferContentType(key)
      // 测试延时（模拟慢速复制，方便测试排队/后台继续）
      if (TASK_DELAY_MS > 0) {
        await new Promise(resolve => setTimeout(resolve, TASK_DELAY_MS))
      }
      await copyObjectStream(
        params.sourceInstance,
        params.sourceBucket,
        key,
        params.targetInstance,
        params.targetBucket,
        targetKey,
        contentType,
      )
      const result: FileResult = { status: 'success', duration: Date.now() - startTime }
      task.fileProgress.results[key] = result
      copiedKeys.push(key)
      emit({
        event: 'progress',
        data: { taskId: task.taskId, objectKey: key, result },
      })
    } catch (err: unknown) {
      const errorMsg = formatExecError(err)
      const result: FileResult = {
        status: 'failed',
        duration: Date.now() - startTime,
        error: errorMsg,
      }
      task.fileProgress.results[key] = result
      emit({
        event: 'progress',
        data: { taskId: task.taskId, objectKey: key, result },
      })
    }
  }

  // 取消时未开始的文件标记 skipped，并 emit 让前端列表同步
  for (const key of keyArray) {
    if (task.fileProgress.results[key]?.status === 'pending') {
      const result: FileResult = { status: 'skipped' }
      task.fileProgress.results[key] = result
      emit({
        event: 'progress',
        data: { taskId: task.taskId, objectKey: key, result },
      })
    }
  }

  return copiedKeys
}

/** 创建复制执行器 */
export function createCopyExecutor(params: CopyParams): TaskExecutor {
  return {
    async execute(task: Task, emit, isCancelled) {
      await copyObjectsPhase(task, emit, isCancelled, params)
      task.summary = computeFileSummary(task.fileProgress)
    },
  }
}
