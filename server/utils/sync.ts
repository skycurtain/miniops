import type {
  MinioInstance,
  SyncEvent,
  SyncFileInfo,
  SyncResult,
  SyncTask,
} from '../types'
import {
  getObjectStream,
  listObjects,
  uploadFromStream,
  headObject,
  inferContentType,
  sanitizeObjectKey,
} from './minio'

/**
 * 实例间同步执行器
 *
 * 克隆 dispatcher.ts 的框架结构，适配同步语义：
 * - 两阶段：先扫描展开源对象（scanning），再逐实例并发同步（running）
 * - 实例维度并发（默认 5），实例内文件串行
 * - 源端 getObjectStream -> 目标端 uploadFromStream，流式直传不落盘
 * - 每个文件完成后通知订阅者（SSE）
 */

/** 并发数，与 dispatch 共用 DISPATCH_CONCURRENCY */
const CONCURRENCY = Number(process.env.DISPATCH_CONCURRENCY) || 5

/** 扫描对象上限保护，防止全量扫描导致长时间阻塞 */
const SYNC_SCAN_LIMIT = 10000

// ---------- 任务注册表 ----------

interface SyncTaskEntry {
  task: SyncTask
  subscribers: Array<(event: SyncEvent) => void>
}

const syncRegistry = new Map<string, SyncTaskEntry>()

/** 注册任务到内存表 */
export function registerSyncTask(task: SyncTask): void {
  syncRegistry.set(task.id, { task, subscribers: [] })
}

/** 订阅任务事件（SSE 连接调用），返回取消订阅函数 */
export function subscribeSyncTask(
  taskId: string,
  callback: SyncTaskEntry['subscribers'][number],
): () => void {
  const entry = syncRegistry.get(taskId)
  if (!entry) return () => {}

  const task = entry.task

  // 如果任务已完成，立即推送 complete 事件
  if (task.status === 'done') {
    // 先补发 scan-complete（如果已扫描），再发 complete
    if (task.resolvedFiles.length > 0) {
      const totalSize = task.resolvedFiles.reduce((s, f) => s + f.size, 0)
      callback({
        type: 'scan-complete',
        taskId,
        files: task.resolvedFiles,
        totalCount: task.resolvedFiles.length,
        totalSize,
      })
    }
    // 补发已收集的 progress 事件
    for (const r of task.results) {
      callback({ type: 'progress', taskId, result: r })
    }
    const results = task.results
    const summary = {
      total: results.length,
      success: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length,
    }
    callback({ type: 'complete', taskId, summary })
    return () => {}
  }

  // 如果任务正在执行（scanning 或 running），且扫描已完成，
  // 补发 scan-complete 事件，携带已扫描的 resolvedFiles
  if ((task.status === 'scanning' || task.status === 'running') && task.resolvedFiles.length > 0) {
    const totalSize = task.resolvedFiles.reduce((s, f) => s + f.size, 0)
    callback({
      type: 'scan-complete',
      taskId,
      files: task.resolvedFiles,
      totalCount: task.resolvedFiles.length,
      totalSize,
    })
  }

  // 如果任务已进入 running，补发已收集的 progress 事件
  if (task.status === 'running') {
    for (const r of task.results) {
      callback({ type: 'progress', taskId, result: r })
    }
  }

  entry.subscribers.push(callback)
  return () => {
    const idx = entry.subscribers.indexOf(callback)
    if (idx >= 0) entry.subscribers.splice(idx, 1)
  }
}

/** 通知任务的所有订阅者 */
function notifySync(taskId: string, event: SyncEvent): void {
  const entry = syncRegistry.get(taskId)
  if (!entry) return
  for (const sub of entry.subscribers) {
    try { sub(event) } catch { /* 忽略已关闭的连接 */ }
  }
}

/** 获取任务（用于查询状态） */
export function getSyncTask(taskId: string): SyncTask | null {
  return syncRegistry.get(taskId)?.task ?? null
}

// ---------- 同步执行 ----------

/**
 * 执行同步任务。
 * 两阶段：扫描（scanning）-> 同步（running）。
 * 同步阶段实例维度并发（CONCURRENCY），实例内文件串行。
 */
export async function executeSync(taskId: string): Promise<void> {
  const entry = syncRegistry.get(taskId)
  if (!entry) return
  const { task } = entry

  try {
    // ── 阶段 1：扫描 ──────────────────────────────────────────
    task.status = 'scanning'
    notifySync(taskId, { type: 'scan-progress', taskId, scannedCount: 0 })

    const resolvedFiles = await scanSourceObjects(task)
      task.resolvedFiles = resolvedFiles

    const totalSize = resolvedFiles.reduce((s, f) => s + f.size, 0)
    notifySync(taskId, {
      type: 'scan-complete',
      taskId,
      files: resolvedFiles,
      totalCount: resolvedFiles.length,
      totalSize,
    })

    // ── 阶段 2：同步（实例维度并发） ──────────────────────────
    task.status = 'running'
    notifySync(taskId, { type: 'start', taskId })
  
    const queue = [...task.resolvedInstances]
    const running: Promise<void>[] = []

    while (queue.length > 0 || running.length > 0) {
      while (running.length < CONCURRENCY && queue.length > 0) {
        const instance = queue.shift()!
        const p = processInstanceSync(taskId, task, instance)
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

    // ── 阶段 3：完成 ──────────────────────────────────────────
    task.status = 'done'
    task.finishedAt = new Date().toISOString()
    const summary = {
      total: task.results.length,
      success: task.results.filter(r => r.status === 'success').length,
      failed: task.results.filter(r => r.status === 'failed').length,
    }
    notifySync(taskId, { type: 'complete', taskId, summary })
  
    // 延迟清理（保留 60s 供迟到的 SSE 连接查询）
    setTimeout(() => syncRegistry.delete(taskId), 60_000)
  } catch (e: any) {
    // 扫描阶段失败 -> 直接完成（带错误信息）
    task.status = 'done'
    task.finishedAt = new Date().toISOString()
    notifySync(taskId, {
      type: 'complete',
      taskId,
      summary: { total: 0, success: 0, failed: 0 },
    })
    setTimeout(() => syncRegistry.delete(taskId), 60_000)
    console.error('[sync] 任务 ' + taskId + ' 执行异常:', e?.message || e)
  }
}

/**
 * 扫描源端对象：合并 keys + 递归展开 prefixes，返回完整对象列表。
 * 对直接勾选的对象用 headObject 补全 size。
 */
async function scanSourceObjects(task: SyncTask): Promise<SyncFileInfo[]> {
  const { source } = task.request
  const { sourceInstance } = task
  const resolvedFiles: SyncFileInfo[] = []
  const seen = new Set<string>()

  // 1a. 直接加入勾选的具体对象
  for (const key of source.keys) {
    if (seen.has(key)) continue
    seen.add(key)
    resolvedFiles.push({
      key,
      relativeKey: computeRelativeKey(key, source.prefix),
      size: 0, // 后面用 headObject 补全
      contentType: inferContentType(key),
    })
    notifySync(task.id, { type: 'scan-progress', taskId: task.id, scannedCount: resolvedFiles.length })
  }

  // 1b. 递归展开文件夹前缀
  for (const prefix of source.prefixes) {
    let continuationToken: string | undefined
    do {
      const result = await listObjects(sourceInstance, source.bucket, prefix, '', continuationToken)
      if (result.error) {
        throw new Error('列出源对象失败: ' + result.error)
      }
      for (const obj of result.objects) {
        if (seen.has(obj.key)) continue
        seen.add(obj.key)
        resolvedFiles.push({
          key: obj.key,
          relativeKey: computeRelativeKey(obj.key, source.prefix),
          size: obj.size,
          contentType: inferContentType(obj.key),
        })
      }

      // 上限保护
      if (resolvedFiles.length > SYNC_SCAN_LIMIT) {
        throw new Error('源对象数量超过上限 ' + SYNC_SCAN_LIMIT + '，请缩小同步范围')
      }

      notifySync(task.id, { type: 'scan-progress', taskId: task.id, scannedCount: resolvedFiles.length })
      continuationToken = result.isTruncated ? result.continuationToken : undefined
    } while (continuationToken)
  }

  // 1c. 对直接勾选的对象补全 size（listObjects 没返回的）
  for (const f of resolvedFiles) {
    if (f.size === 0) {
      const meta = await headObject(sourceInstance, source.bucket, f.key)
      if (meta) {
        f.size = meta.size
        if (meta.contentType && f.contentType === 'application/octet-stream') {
          f.contentType = meta.contentType
        }
      }
    }
  }

  return resolvedFiles
}

/**
 * 计算对象相对源浏览前缀的路径。
 * sourcePrefix = "config/", key = "config/data/app.json" -> "data/app.json"
 * sourcePrefix = "", key = "config/app.json" -> "config/app.json"
 */
function computeRelativeKey(key: string, sourcePrefix: string): string {
  if (!sourcePrefix) return key
  if (key.startsWith(sourcePrefix)) return key.slice(sourcePrefix.length)
  return key
}

/** 处理单个目标实例：遍历所有文件，逐个从源端拉取流式上传到目标 */
async function processInstanceSync(
  taskId: string,
  task: SyncTask,
  instance: MinioInstance,
): Promise<void> {
  const targetBucket = task.request.targets.instanceBuckets[instance.id]
  const targetPrefix = task.request.targets.prefix
  const sourceBucket = task.request.source.bucket

  for (const f of task.resolvedFiles) {
    const result: SyncResult = {
      instanceId: instance.id,
      instanceName: instance.name,
      fileName: f.relativeKey,
      status: 'success',
    }

    // 没有 bucket：直接失败
    if (!targetBucket) {
      result.status = 'failed'
      result.error = '未指定 bucket'
      task.results.push(result)
      notifySync(taskId, { type: 'progress', taskId, result })
      continue
    }

    const targetKey = sanitizeObjectKey(
      targetPrefix
        ? targetPrefix.replace(/\/+$/, '') + '/' + f.relativeKey
        : f.relativeKey,
    )

    const start = Date.now()
    try {
          // 源端拉取
      const { response, error, cleanup } = await getObjectStream(
        task.sourceInstance, sourceBucket, f.key,
      )
          if (!response || !response.body) {
        throw new Error(error || '源对象不可读')
      }

      // 从源响应头获取 size 和 contentType
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10) || f.size
      const contentType = response.headers.get('content-type') || f.contentType

      // 流式上传到目标
      // 注意：大文件（≥8MB）走 uploadLargeFromStream，内部用 streamToParts 从整文件流切分。
      // 若超大文件超 10 分钟 GetObject 超时，后续优化为 Range 请求逐片拉取。
      await uploadFromStream(instance, targetBucket, targetKey, response.body, contentLength, contentType)
    
      cleanup?.()

      result.duration = Date.now() - start
      task.results.push(result)
      notifySync(taskId, { type: 'progress', taskId, result })
    }
    catch (e: any) {
          result.status = 'failed'
      result.error = e?.message || '同步失败'
      result.duration = Date.now() - start
      task.results.push(result)
      notifySync(taskId, { type: 'progress', taskId, result })
    }
  }
}
