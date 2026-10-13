import { readFile } from 'node:fs/promises'
import { uploadObjectStream, inferContentType, formatExecError } from '#server/utils/s3'
import { getStagedFiles, removeStagedFile } from '#server/utils/staging'
import type { TaskExecutor, Task } from '#server/utils/task-manager'
import type { FileResult, TaskSummary } from '#shared/schemas/task'
import type { S3Instance } from '#shared/schemas/groups'

const TASK_DELAY_MS = Number(process.env.TASK_DELAY_MS) || 0

/** 上传任务参数（API 层查找实例后传入，executor 不依赖 store.ts） */
export interface UploadParams {
  files: { fileId: string; objectKey: string }[] // 已暂存的文件 + 相对 objectKey
  instance: S3Instance
  bucket: string
  prefix: string // 目标前缀（已由 API 层 sanitizeObjectKey 清洗）
}

/** 从 fileProgress 统计摘要（pending 归入 skipped，与 copy.ts 一致） */
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
 * 创建上传执行器。
 *
 * 单实例、文件串行（上传本质是"单实例分发"的退化形态）：
 * - readFile 读暂存磁盘 + uploadObjectStream 单次 PUT（与 DispatchExecutor 同构）
 * - 扁平 fileProgress（无 instanceId 维度）
 * - 取消检查点：每文件开始前，未开始的标记 skipped
 * - 结束后清理暂存文件（成功/失败/取消都清理）
 */
export function createUploadExecutor(params: UploadParams): TaskExecutor {
  return {
    async execute(task, emit, isCancelled) {
      const stagedFiles = getStagedFiles(params.files.map(f => f.fileId))

      // 初始化 fileProgress：所有 objectKey 标记为 pending
      for (const f of stagedFiles) {
        task.fileProgress.results[f.objectKey] = { status: 'pending' }
      }

      for (const file of stagedFiles) {
        // 取消检查点：未开始的文件标记 skipped
        if (isCancelled()) break

        task.fileProgress.results[file.objectKey] = { status: 'running' }
        emit({
          event: 'progress',
          data: { taskId: task.taskId, objectKey: file.objectKey, result: { status: 'running' } },
        })

        const startTime = Date.now()
        try {
          const fullKey = params.prefix
            ? `${params.prefix}/${file.objectKey}`
            : file.objectKey
          // 测试延时（模拟慢速上传，方便测试排队/后台继续）
          if (TASK_DELAY_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, TASK_DELAY_MS))
          }
          const body = await readFile(file.diskPath)
          await uploadObjectStream(
            params.instance,
            params.bucket,
            fullKey,
            body,
            inferContentType(file.objectKey),
            file.size,
          )
          const result: FileResult = { status: 'success', duration: Date.now() - startTime }
          task.fileProgress.results[file.objectKey] = result
          emit({
            event: 'progress',
            data: { taskId: task.taskId, objectKey: file.objectKey, result },
          })
        } catch (err: unknown) {
          const errorMsg = formatExecError(err)
          const result: FileResult = {
            status: 'failed',
            duration: Date.now() - startTime,
            error: errorMsg,
          }
          task.fileProgress.results[file.objectKey] = result
          emit({
            event: 'progress',
            data: { taskId: task.taskId, objectKey: file.objectKey, result },
          })
        }
      }

      // 取消时未开始的文件标记 skipped（区别于 failed），并 emit 让前端列表同步
      for (const file of stagedFiles) {
        if (task.fileProgress.results[file.objectKey]?.status === 'pending') {
          const result: FileResult = { status: 'skipped' }
          task.fileProgress.results[file.objectKey] = result
          emit({
            event: 'progress',
            data: { taskId: task.taskId, objectKey: file.objectKey, result },
          })
        }
      }

      // 汇总
      task.summary = computeFileSummary(task.fileProgress)

      // 清理暂存文件（无论成功/失败/取消）
      for (const f of stagedFiles) {
        await removeStagedFile(f.fileId).catch(() => {})
      }
    },
  }
}
