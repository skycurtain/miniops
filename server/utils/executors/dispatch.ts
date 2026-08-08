import { readFile } from 'node:fs/promises'
import {
  uploadObjectStream,
  sanitizeObjectKey,
} from '#server/utils/minio'
import { getStagedFiles, removeStagedFile } from '#server/utils/staging'
import { getGroups } from '#server/utils/store'
import type { TaskExecutor, Task } from '#server/utils/task-manager'
import type { InstanceProgress, FileResult, TaskSummary } from '#shared/schemas/task'
import type { MinioInstance } from '#shared/schemas/groups'

const DISPATCH_CONCURRENCY = Number(process.env.DISPATCH_CONCURRENCY) || 5
const DISPATCH_DELAY_MS = Number(process.env.DISPATCH_DELAY_MS) || 0

/** 查找实例配置 */
async function findInstance(instanceId: string): Promise<MinioInstance | undefined> {
  const groups = await getGroups()
  for (const g of groups) {
    const inst = g.instances.find((i) => i.id === instanceId)
    if (inst) return inst
  }
  return undefined
}

/** 计算实例维度摘要 */
function computeInstanceSummary(instanceProgress: InstanceProgress[]): TaskSummary {
  let total = 0
  let success = 0
  let failed = 0
  let skipped = 0
  for (const inst of instanceProgress) {
    for (const result of Object.values(inst.results)) {
      total++
      if (result.status === 'success') success++
      else if (result.status === 'failed') failed++
      else if (result.status === 'skipped') skipped++
    }
  }
  return { total, success, failed, skipped }
}

/** 创建分发执行器 */
export function createDispatchExecutor(
  files: { fileId: string; objectKey: string }[],
  targets: { instanceId: string; bucket: string }[],
  prefix: string,
): TaskExecutor {
  return {
    async execute(task: Task, emit, isCancelled) {
      const stagedFiles = getStagedFiles(files.map((f) => f.fileId))

      // 查找所有目标实例配置
      const instanceMap = new Map<string, MinioInstance>()
      for (const target of targets) {
        const inst = await findInstance(target.instanceId)
        if (inst) instanceMap.set(target.instanceId, inst)
      }

      // 初始化 instanceProgress
      for (const target of targets) {
        const inst = instanceMap.get(target.instanceId)
        const progress: InstanceProgress = {
          instanceId: target.instanceId,
          instanceName: inst?.name || target.instanceId,
          bucket: target.bucket,
          results: {},
        }
        for (const f of stagedFiles) {
          progress.results[f.objectKey] = { status: 'pending' }
        }
        task.instanceProgress.push(progress)
      }

      // 单个实例的分发逻辑
      const runInstance = async (target: { instanceId: string; bucket: string }) => {
        const inst = instanceMap.get(target.instanceId)
        const progress = task.instanceProgress.find((p) => p.instanceId === target.instanceId)!

        if (!inst) {
          // 实例不存在，标记所有文件失败
          for (const f of stagedFiles) {
            progress.results[f.objectKey] = { status: 'failed', error: '实例不存在' }
            emit({
              event: 'progress',
              data: { taskId: task.taskId, objectKey: f.objectKey, result: { status: 'failed', error: '实例不存在' }, instanceId: target.instanceId },
            })
          }
          return
        }

        for (const file of stagedFiles) {
          if (isCancelled()) {
            if (progress.results[file.objectKey]?.status === 'pending') {
              progress.results[file.objectKey] = { status: 'skipped' }
              emit({
                event: 'progress',
                data: { taskId: task.taskId, objectKey: file.objectKey, result: { status: 'skipped' }, instanceId: target.instanceId },
              })
            }
            continue
          }

          progress.results[file.objectKey] = { status: 'running' }
          emit({
            event: 'progress',
            data: { taskId: task.taskId, objectKey: file.objectKey, result: { status: 'running' }, instanceId: target.instanceId },
          })

          const startTime = Date.now()
          try {
            const fullKey = prefix
              ? `${sanitizeObjectKey(prefix)}/${file.objectKey}`
              : file.objectKey
            // 测试延时（模拟慢速分发）
            if (DISPATCH_DELAY_MS > 0) {
              await new Promise(resolve => setTimeout(resolve, DISPATCH_DELAY_MS))
            }
            const body = await readFile(file.diskPath)
            await uploadObjectStream(inst, target.bucket, fullKey, body, file.contentType, file.size)
            const duration = Date.now() - startTime
            const result: FileResult = { status: 'success', duration }
            progress.results[file.objectKey] = result
            emit({
              event: 'progress',
              data: { taskId: task.taskId, objectKey: file.objectKey, result, instanceId: target.instanceId },
            })
          } catch (err: any) {
            const result: FileResult = { status: 'failed', error: err?.message || String(err) }
            progress.results[file.objectKey] = result
            emit({
              event: 'progress',
              data: { taskId: task.taskId, objectKey: file.objectKey, result, instanceId: target.instanceId },
            })
          }
        }
      }

      // 并发池：最多 DISPATCH_CONCURRENCY 个实例同时分发
      const targetQueue = [...targets]
      const concurrency = Math.min(DISPATCH_CONCURRENCY, targets.length)
      const worker = async () => {
        while (targetQueue.length > 0) {
          const target = targetQueue.shift()
          if (target) await runInstance(target)
        }
      }
      const workers = Array.from({ length: concurrency }, () => worker())
      await Promise.all(workers)

      // 汇总
      task.summary = computeInstanceSummary(task.instanceProgress)

      // 清理暂存文件
      for (const f of stagedFiles) {
        await removeStagedFile(f.fileId).catch(() => {})
      }
    },
  }
}
