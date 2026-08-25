import { deleteObjects } from '#server/utils/minio'
import { copyObjectsPhase, type CopyParams } from './copy'
import type { TaskExecutor, Task } from '#server/utils/task-manager'
import type { FileResult, TaskSummary, TaskEvent } from '#shared/schemas/task'

/** 移动参数继承复制参数（完全相同结构） */
export type MoveParams = CopyParams

/** 从 fileProgress 统计移动摘要 */
function computeMoveSummary(results: Record<string, FileResult>): TaskSummary {
  let success = 0
  let failed = 0
  let skipped = 0
  for (const r of Object.values(results)) {
    if (r.status === 'skipped' || r.status === 'pending') {
      skipped++
      continue
    }
    if (r.status === 'failed') {
      failed++
      continue
    }
    // status === 'success'（复制成功），看删除结果
    if (r.sourceDeleteStatus === 'deleted') {
      success++
    } else if (r.sourceDeleteStatus === 'delete-failed') {
      failed++
    } else {
      // 复制成功但未及删除（取消中断），计入 failed
      failed++
    }
  }
  return {
    total: Object.keys(results).length,
    success,
    failed,
    skipped,
  }
}

/** 创建移动执行器 */
export function createMoveExecutor(params: MoveParams): TaskExecutor {
  return {
    async execute(task: Task, emit: (event: TaskEvent) => void, isCancelled: () => boolean) {
      // -- 阶段 1：复制（复用 copyObjectsPhase） --
      task.currentPhase = 'copying'
      emit({ event: 'phase', data: { taskId: task.taskId, phase: 'copying' } })

      const copiedKeys = await copyObjectsPhase(task, emit, isCancelled, params)

      // 复制阶段取消，不进入删除
      if (isCancelled()) {
        task.summary = computeMoveSummary(task.fileProgress.results)
        return
      }

      // -- 阶段 2：删除源对象 --
      if (copiedKeys.length > 0) {
        task.currentPhase = 'deleting'
        emit({ event: 'phase', data: { taskId: task.taskId, phase: 'deleting' } })

        // deleteObjects 一次性批量删除（内部自动分批每 1000 个）
        const result = await deleteObjects(
          params.sourceInstance,
          params.sourceBucket,
          copiedKeys,
        )

        // 逐个更新 fileProgress 并发 progress 事件
        for (const key of result.deleted) {
          const r = task.fileProgress.results[key]
          if (r) {
            r.sourceDeleteStatus = 'deleted'
            emit({
              event: 'progress',
              data: { taskId: task.taskId, objectKey: key, result: { ...r } },
            })
          }
        }
        for (const err of result.errors) {
          const r = task.fileProgress.results[err.key]
          if (r) {
            r.sourceDeleteStatus = 'delete-failed'
            r.sourceDeleteError = err.error
            emit({
              event: 'progress',
              data: { taskId: task.taskId, objectKey: err.key, result: { ...r } },
            })
          }
        }
      }

      // -- 汇总 --
      task.summary = computeMoveSummary(task.fileProgress.results)
    },
  }
}
