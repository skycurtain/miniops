# 提议 3 实施计划：实例间文件同步（后端共用方案）

> **目标**：从源 MinIO 实例拉取对象，流式同步到一组目标 MinIO 实例，全程不落盘暂存磁盘。
>
> 配套交互设计文档：
> - `P0_DESIGN_03A_BROWSER_SYNC.md`（第一部分：浏览器内快捷同步）
> - `P0_DESIGN_03B_SYNC_PAGE.md`（第二部分：独立同步页面）
>
> 本文档描述后端共用方案（minio.ts 流式上传 + sync.ts 任务框架 + API 路由 + 前端 composable）。前端入口的改动在两个部分中分别实现。

---

## 一、现状分析

### 1.1 核心结论：新增流式上传能力 + 克隆任务框架

与提议 13（后端零改动）不同，提议 3 需要后端新增能力：

1. **现有 `uploadObject` 强依赖磁盘路径**（`localPath: string`，minio.ts:447），同步要"不落盘"必须新增流式上传函数。
2. **没有 sync 任务框架**，需克隆 dispatcher.ts 的 taskRegistry + SSE 模式。
3. **前端需新建 Modal 组件 + composable**，大量复用 dispatch/browser 的 UI 零件和交互模式。第一部分不需要独立页面。

### 1.2 现有可复用能力

```
后端（直接复用，不改）：
  server/utils/minio.ts
    ├ getObjectStream()        L1061  ← 源端拉取，返回 Web ReadableStream（核心零件）
    ├ listObjects()            L728   ← 源端列出对象/前缀（选源 + 扫描展开）
    ├ listBuckets()            L339   ← 源/目标实例 bucket 列表
    ├ presignPutUrl()          L205   ← 目标端小文件 PUT 签名
    ├ signRequest()            L274   ← 通用签名（multipart 各步用）
    ├ inferContentType()       L689   ← MIME 推断
    └ sanitizeObjectKey()      L704   ← key 清洗

  server/utils/store.ts
    ├ withLock()               L36    ← 互斥锁模式（参考，sync 用独立锁实例）
    └ genId()                  L86    ← ID 生成

  server/api/instances/buckets.post.ts  ← 批量获取 bucket 列表（前后端复用）
  server/api/instances/objects/list.post.ts ← 列出对象（前端复用）

前端（复用 UI 模式）：
  app/pages/ops/dispatch/index.vue
    ├ 实例树 + 组级/实例级 bucket 选择器  L260-295  ← 目标选择区复用
    ├ 进度聚合折叠视图                     L314-360  ← 进度区复用
    └ 提交栏模式                           L306-311  ← 提交栏复用

  app/pages/ops/browser/index.vue
    ├ 实例/bucket 选择器                   L742-795  ← 源选择区复用
    ├ 对象列表 + 多选                      L920-1010 ← 源对象列表复用
    ├ 面包屑导航                           L830-846  ← 前缀导航复用
    └ selectedKeys / selectedPrefixes     L400-401  ← 选中产物复用

  app/components/BrowserUploadModal.vue
    └ SSE 订阅模式                         L327-387  ← sync 进度订阅参考

  app/components/AppLayout.vue
    └ navItems                            L3-16     ← 导航项添加点
```

### 1.3 缺失能力

**后端新增**：

| 零件 | 说明 |
|---|---|
| `uploadFromStream()` | 流式上传函数，数据源从磁盘路径改为 Web ReadableStream |
| `streamToParts()` | 流式分片器，从源流按 PART_SIZE 切分 |
| `server/utils/sync.ts` | sync 任务框架（克隆 dispatcher.ts） |
| `POST /api/sync` | 提交同步任务 |
| `GET /api/sync/events` | SSE 进度推送（含扫描阶段事件） |
| 类型定义 | SyncRequest / SyncTask / SyncResult / SyncEvent 等 |

**前端新增**：

| 零件 | 说明 |
|---|---|
| `app/composables/useSync.ts` | sync 状态管理 + SSE 订阅（在 browser 页实例化） |
| `app/components/SyncTargetModal.vue` | 同步 Modal（目标选择 + 进度展示，两阶段） |
| `app/components/SyncFloatingIndicator.vue` | 右下角悬浮进度指示器 |

**前端修改**：

| 文件 | 改动 |
|---|---|
| `app/pages/ops/browser/index.vue` | 工具栏新增"同步到..."按钮 + 引入 Modal + 引入悬浮指示器 |

---

## 二、改动清单

### 2.1 后端

| 文件 | 操作 | 说明 |
|---|---|---|
| `server/utils/minio.ts` | 修改 | 新增 `uploadFromStream()` + `streamToParts()` 辅助函数 |
| `server/utils/sync.ts` | 新建 | sync 任务框架（taskRegistry + SSE + executeSync） |
| `server/types/index.ts` | 修改 | 新增 sync 相关类型定义 |
| `server/api/sync/index.post.ts` | 新建 | 提交同步任务 |
| `server/api/sync/events.get.ts` | 新建 | SSE 进度推送 |

### 2.2 前端

| 文件 | 操作 | 说明 |
|---|---|---|
| `app/composables/useSync.ts` | 新建 | sync 状态管理 + SSE 订阅（在 browser 页实例化，通过 props 传入 Modal） |
| `app/components/SyncTargetModal.vue` | 新建 | 同步 Modal（目标选择 + 进度展示两阶段） |
| `app/components/SyncFloatingIndicator.vue` | 新建 | 右下角悬浮进度指示器 |
| `app/pages/ops/browser/index.vue` | 修改 | 工具栏新增"同步到..."按钮 + 引入 Modal + 引入悬浮指示器 |

**总计：后端 1 改 3 新，前端 1 改 3 新。零新增依赖（纯 `node:crypto` + `fetch`）。**

---

## 三、技术设计

### 3.1 类型定义（server/types/index.ts）

在现有 dispatch 类型之后追加：

```typescript
// ── 实例间同步 ──────────────────────────────────────────────

/** 同步源配置 */
interface SyncSource {
  instanceId: string
  bucket: string
  prefix: string                    // 源浏览前缀（用于计算相对路径），如 "config/"
  keys: string[]                    // 勾选的具体对象 key（完整路径）
  prefixes: string[]                // 勾选的文件夹前缀（递归展开）
}

/** 同步目标配置（与 DispatchRequest 的目标部分同构） */
interface SyncTarget {
  instanceIds: string[]
  instanceBuckets: Record<string, string>
  prefix: string                    // 目标前缀
}

/** 同步请求 */
interface SyncRequest {
  source: SyncSource
  targets: SyncTarget
}

/** 扫描后的源对象信息 */
interface SyncFileInfo {
  key: string                       // 源端完整 key（如 "config/data/app.json"）
  relativeKey: string               // 相对源浏览前缀的路径（如 "data/app.json"）
  size: number
  contentType: string
}

/** 同步结果（与 DispatchResult 同构，复用前端进度视图） */
interface SyncResult {
  instanceId: string
  instanceName: string
  fileName: string                  // = relativeKey（相对路径），用于目标 key 拼接
  status: 'success' | 'failed'
  error?: string
  duration?: number
}

/** 同步任务 */
interface SyncTask {
  id: string
  request: SyncRequest
  status: 'pending' | 'scanning' | 'running' | 'done'
  resolvedInstances: MinioInstance[]   // 目标实例列表（仅目标，不含源）
  sourceInstance: MinioInstance        // 源实例（单独存，不在 resolvedInstances 中）
  resolvedFiles: SyncFileInfo[]        // 扫描展开后的对象列表
  results: SyncResult[]                // instance×file 结果矩阵
  createdAt: string
  finishedAt?: string
}

/** 同步 SSE 事件 */
interface SyncEvent {
  type: 'scan-progress' | 'scan-complete' | 'start' | 'progress' | 'complete'
  taskId: string
  scannedCount?: number                // scan-progress: 已发现对象数
  files?: SyncFileInfo[]               // scan-complete: 完整对象列表
  totalCount?: number                  // scan-complete: 总数
  totalSize?: number                   // scan-complete: 总大小
  result?: SyncResult                  // progress: 单文件结果
  summary?: { total: number; success: number; failed: number }  // complete
}
```

**设计要点**：
- `SyncResult` 与 `DispatchResult`（types:99-108）字段同构，前端进度视图可直接复用。
- `SyncTask.status` 比 `DispatchTask` 多一个 `'scanning'` 阶段，对应扫描阶段。
- `sourceInstance` 单独存，与 `resolvedInstances`（目标实例）分离，语义清晰。
- `SyncFileInfo.relativeKey` 是去掉源浏览前缀后的相对路径，直接用于目标 key 拼接：`targetPrefix + relativeKey`。

### 3.2 流式上传函数（server/utils/minio.ts）

**核心原则**：不修改现有 `uploadObject` / `uploadSmall` / `uploadLarge`（它们被 dispatcher.ts 和 BrowserUploadModal 使用），而是新增流式版本。

#### 3.2.1 uploadFromStream -- 统一入口

```typescript
/**
 * 从 Web ReadableStream 上传对象到目标实例。
 * 小文件（size < MULTIPART_THRESHOLD）走单次预签名 PUT，
 * 大文件走 Multipart Upload（流式分片）。
 *
 * @param instance  目标实例
 * @param bucket    目标 bucket
 * @param objectKey 目标 key（已含 prefix）
 * @param stream    源端 Web ReadableStream
 * @param size      对象总大小（字节，从源端 Content-Length 获取）
 * @param contentType  Content-Type
 */
export async function uploadFromStream(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  stream: ReadableStream<Uint8Array>,
  size: number,
  contentType: string,
): Promise<void> {
  if (size < MULTIPART_THRESHOLD) {
    await uploadSmallFromStream(instance, bucket, objectKey, stream, size, contentType)
  } else {
    await uploadLargeFromStream(instance, bucket, objectKey, stream, size, contentType)
  }
}
```

#### 3.2.2 uploadSmallFromStream -- 小文件流式 PUT

现有 `uploadSmall`（minio.ts:463-492）用 `readFile(localPath)` 读成 Buffer 作为 fetch body。流式版直接用 Web ReadableStream 作为 body：

```typescript
async function uploadSmallFromStream(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  stream: ReadableStream<Uint8Array>,
  size: number,
  contentType: string,
): Promise<void> {
  const presignedUrl = presignPutUrl({
    endpoint: instance.endpoint,
    bucket,
    objectKey,
    accessKey: instance.accessKey,
    secretKey: instance.secretKey,
    region: instance.region || 'us-east-1',
    contentType,
    expiresIn: 600,
  })

  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: stream,                    // ← Web ReadableStream 直接作为 body（undici 支持）
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(size), // ← 从源端透传，预签名 PUT 需要
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`上传失败: ${response.status} ${response.statusText} ${text}`)
  }
}
```

**与现有 `uploadSmall` 的差异**：
- body 从 `Buffer`（minio.ts:484）改为 `ReadableStream`
- 新增 `Content-Length` header（从源端 size 透传，现有版从 `statSync` 获取）
- 预签名用 `UNSIGNED-PAYLOAD`（presignPutUrl 内部逻辑不变，不签 body 内容），所以 body 可流式

#### 3.2.3 uploadLargeFromStream -- 大文件流式 Multipart

现有 `uploadLarge`（minio.ts:503-610）用 `fd.read` 按偏移从磁盘读 Buffer 切片。流式版用流式分片器从源流读取：

```typescript
async function uploadLargeFromStream(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  stream: ReadableStream<Uint8Array>,
  size: number,
  contentType: string,
): Promise<void> {
  const partSize = MULTIPART_PART_SIZE
  const partCount = Math.ceil(size / partSize)

  // 1. Initiate Multipart Upload（复用现有 signRequest 签名）
  const uploadId = await initiateMultipartUpload(instance, bucket, objectKey, contentType)

  const parts: { partNumber: number; etag: string }[] = []

  try {
    // 2. 流式分片上传
    const partStreams = streamToParts(stream, partSize)
    let partNumber = 1

    for await (const chunk of partStreams) {
      const etag = await uploadPart(instance, bucket, objectKey, uploadId, partNumber, chunk, contentType)
      parts.push({ partNumber, etag })
      partNumber++
    }

    // 3. Complete Multipart Upload
    await completeMultipartUpload(instance, bucket, objectKey, uploadId, parts)
  } catch (err) {
    // 失败时清理 MinIO 侧残留
    await abortMultipartUpload(instance, bucket, objectKey, uploadId).catch(() => {})
    throw err
  }
}
```

> `initiateMultipartUpload` / `uploadPart` / `completeMultipartUpload` / `abortMultipartUpload` 这些函数在现有 `uploadLarge`（minio.ts:503-610）中已实现（内联在函数体内），需要**提取为独立函数**供流式版复用。这是一个小的重构：把 `uploadLarge` 内部的 multipart 步骤提取为可复用的独立函数，原有 `uploadLarge` 改为调用它们。

#### 3.2.4 streamToParts -- 流式分片器

**核心难点**：从 Web ReadableStream 读取，按 `partSize` 边界切分，每个 part 作为 `Buffer`（或 `Uint8Array`）传给 fetch body。

**内存策略**：每片在内存中缓冲 `partSize` 字节（默认 8MB），不是整个文件。内存峰值 = `PART_SIZE`，与现有 `uploadLarge` 的 `Buffer.alloc(end - start)`（minio.ts:549）一致。

```typescript
/**
 * 从 Web ReadableStream 按 partSize 切分，yield 每个 part 的 Buffer。
 *
 * 内存模型：每片缓冲 partSize 字节后 yield，不累积整个文件。
 * 峰值内存 = partSize（默认 8MB）。
 */
async function* streamToParts(
  stream: ReadableStream<Uint8Array>,
  partSize: number,
): AsyncGenerator<Buffer> {
  const reader = stream.getReader()
  let buffer: Buffer[] = []          // chunk 碎片收集
  let bufferSize = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer.push(Buffer.from(value))
      bufferSize += value.byteLength

      // 累积满一片
      while (bufferSize >= partSize) {
        const combined = Buffer.concat(buffer)
        const part = combined.subarray(0, partSize)
        const remainder = combined.subarray(partSize)

        buffer = remainder.length > 0 ? [remainder] : []
        bufferSize = remainder.length

        yield part                   // ← yield 这一片，调用方 PUT 后释放
      }
    }

    // 最后一片（可能 < partSize）
    if (bufferSize > 0) {
      yield Buffer.concat(buffer)
    }
  } finally {
    reader.releaseLock()
  }
}
```

**为什么用 Buffer 而非子 ReadableStream**：
- 每个 part 的 fetch PUT 是独立请求，用 Buffer 作为 body 最简单可靠。
- 内存峰值 = `partSize`（8MB），与现有 `uploadLarge` 一致。
- 完全流式（每片用独立 ReadableStream 不缓冲）需要更复杂的背压管理，收益不大（8MB 缓冲可接受）。

### 3.3 multipart 函数提取重构

现有 `uploadLarge`（minio.ts:503-610）内部内联了 multipart 的四个步骤。提取为独立函数：

```
提取前（内联在 uploadLarge 中）：
  uploadLarge()
    ├ Initiate: POST /{bucket}/{key}?uploads (signRequest)     L515-535
    ├ UploadPart: PUT /{bucket}/{key}?partNumber=N&uploadId=X  L547-567
    ├ Complete: POST /{bucket}/{key}?uploadId=X (XML body)     L572-595
    └ Abort: DELETE /{bucket}/{key}?uploadId=X                 L602-608

提取后（独立函数，uploadLarge 和 uploadLargeFromStream 共用）：
  initiateMultipartUpload(instance, bucket, key, contentType) -> uploadId
  uploadPart(instance, bucket, key, uploadId, partNumber, data, contentType) -> etag
  completeMultipartUpload(instance, bucket, key, uploadId, parts) -> void
  abortMultipartUpload(instance, bucket, key, uploadId) -> void
```

**重构原则**：提取后 `uploadLarge` 行为不变（仍从磁盘读），只是内部改为调用提取的函数。这是纯重构，不影响现有分发流程。

### 3.4 sync 任务框架（server/utils/sync.ts）

克隆 dispatcher.ts 的框架结构，适配同步语义：

```typescript
// ── 任务注册表（与 dispatcher.ts:24-30 同构） ──────────────

interface SyncTaskEntry {
  task: SyncTask
  subscribers: Array<(event: SyncEvent) => void>
}
const syncRegistry = new Map<string, SyncTaskEntry>()

function registerSyncTask(task: SyncTask): void { /* 同 dispatcher.ts:33 */ }
function subscribeSyncTask(taskId: string, cb: (event: SyncEvent) => void): () => void { /* 同 dispatcher.ts:38-62 */ }
function notifySync(taskId: string, event: SyncEvent): void { /* 同 dispatcher.ts:65-71 */ }
export function getSyncTask(taskId: string): SyncTask | undefined { /* 同 dispatcher.ts:74 */ }

// ── 执行入口 ───────────────────────────────────────────────

const CONCURRENCY = parseInt(process.env.DISPATCH_CONCURRENCY || '5', 10)
const SYNC_SCAN_LIMIT = 10000  // 扫描对象上限保护

export async function executeSync(taskId: string): Promise<void> {
  const entry = syncRegistry.get(taskId)
  if (!entry) return
  const { task } = entry

  // ── 阶段 1：扫描 ──────────────────────────────────────────
  task.status = 'scanning'
  notifySync(taskId, { type: 'scan-progress', taskId, scannedCount: 0 })

  const resolvedFiles: SyncFileInfo[] = []
  const seen = new Set<string>()

  // 1a. 直接加入勾选的具体对象
  for (const key of task.request.source.keys) {
    if (seen.has(key)) continue
    seen.add(key)
    resolvedFiles.push({
      key,
      relativeKey: computeRelativeKey(key, task.request.source.prefix),
      size: 0,            // size 在扫描时从 listObjects 补全
      contentType: inferContentType(key),
    })
  }

  // 1b. 递归展开文件夹前缀
  for (const prefix of task.request.source.prefixes) {
    let continuationToken: string | undefined
    do {
      const result = await listObjects(task.sourceInstance, task.request.source.bucket, prefix, '', continuationToken)
      for (const obj of result.objects) {
        if (seen.has(obj.key)) continue
        seen.add(obj.key)
        resolvedFiles.push({
          key: obj.key,
          relativeKey: computeRelativeKey(obj.key, task.request.source.prefix),
          size: obj.size,
          contentType: inferContentType(obj.key),
        })
      }
      // 上限保护
      if (resolvedFiles.length > SYNC_SCAN_LIMIT) {
        throw new Error(`源对象数量超过上限 ${SYNC_SCAN_LIMIT}，请缩小同步范围`)
      }
      notifySync(taskId, { type: 'scan-progress', taskId, scannedCount: resolvedFiles.length })
      continuationToken = result.continuationToken
    } while (continuationToken)
  }

  // 1c. 对直接勾选的对象补全 size（如果 listObjects 没返回）
  for (const f of resolvedFiles) {
    if (f.size === 0) {
      // 可选：HEAD 请求获取 size，或从 listObjects 补全
      // 简化：小文件 PUT 不需要精确 size，大文件 multipart 需要
      // 这里用 HEAD 补全
      const meta = await headObject(task.sourceInstance, task.request.source.bucket, f.key)
      f.size = meta?.size ?? 0
    }
  }

  task.resolvedFiles = resolvedFiles
  const totalSize = resolvedFiles.reduce((s, f) => s + f.size, 0)
  notifySync(taskId, {
    type: 'scan-complete',
    taskId,
    files: resolvedFiles,
    totalCount: resolvedFiles.length,
    totalSize,
  })

  // ── 阶段 2：同步（实例维度并发，与 dispatcher.ts:91-112 同构） ──
  task.status = 'running'
  notifySync(taskId, { type: 'start', taskId })

  const queue = [...task.resolvedInstances]
  const running: Promise<void>[] = []

  while (queue.length > 0) {
    if (running.length >= CONCURRENCY) {
      await Promise.race(running)
      // 移除已完成的（同 dispatcher.ts:99-104 模式）
    }
    const instance = queue.shift()!
    const p = processInstanceSync(taskId, task, instance)
    running.push(p)
    p.finally(() => { /* 从 running 移除 */ })
  }
  await Promise.all(running)

  // ── 阶段 3：完成 ──────────────────────────────────────────
  task.status = 'done'
  task.finishedAt = new Date().toISOString()
  const summary = {
    total: task.results.length,
    success: task.results.filter(r => r.status === 'success').length,
    failed: task.results.filter(r => r.status === 'failed').length,
  }
  notifySync(taskId, { type: 'complete', taskId, summary })

  // 延迟清理（同 dispatcher.ts:124-125）
  setTimeout(() => syncRegistry.delete(taskId), 60_000)
}
```

#### 3.4.1 processInstanceSync -- 单实例同步

```typescript
async function processInstanceSync(taskId: string, task: SyncTask, instance: MinioInstance): Promise<void> {
  const targetBucket = task.request.targets.instanceBuckets[instance.id]
  if (!targetBucket) {
    // 无 bucket -> 所有文件标记 failed
    for (const f of task.resolvedFiles) {
      const result: SyncResult = {
        instanceId: instance.id,
        instanceName: instance.name,
        fileName: f.relativeKey,
        status: 'failed',
        error: '未指定 bucket',
      }
      task.results.push(result)
      notifySync(taskId, { type: 'progress', taskId, result })
    }
    return
  }

  const targetPrefix = task.request.targets.prefix
  const sourceBucket = task.request.source.bucket

  // 实例内文件串行（同 dispatcher.ts processInstance 模式）
  for (const f of task.resolvedFiles) {
    const targetKey = sanitizeObjectKey(targetPrefix + f.relativeKey)
    const start = Date.now()

    try {
      // 源端拉取
      const { response, cleanup } = await getObjectStream(
        task.sourceInstance, sourceBucket, f.key
      )
      if (!response || !response.body) {
        throw new Error(cleanup ? '源对象不可读' : '源对象不存在')
      }

      // 流式上传到目标
      // 注意：大文件（≥8MB）走 uploadLargeFromStream，内部用 streamToParts 从整文件流切分。
      // 若超大文件超 10 分钟 GetObject 超时，后续优化为 Range 请求逐片拉取（见 5.1 节）。
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10) || f.size
      const contentType = response.headers.get('content-type') || f.contentType

      await uploadFromStream(instance, targetBucket, targetKey, response.body, contentLength, contentType)

      cleanup?.()  // 清理 getObjectStream 的定时器

      const result: SyncResult = {
        instanceId: instance.id,
        instanceName: instance.name,
        fileName: f.relativeKey,
        status: 'success',
        duration: Date.now() - start,
      }
      task.results.push(result)
      notifySync(taskId, { type: 'progress', taskId, result })
    } catch (err: any) {
      const result: SyncResult = {
        instanceId: instance.id,
        instanceName: instance.name,
        fileName: f.relativeKey,
        status: 'failed',
        error: err?.message || '同步失败',
        duration: Date.now() - start,
      }
      task.results.push(result)
      notifySync(taskId, { type: 'progress', taskId, result })
    }
  }
}
```

#### 3.4.2 computeRelativeKey -- 相对路径计算

```typescript
/**
 * 计算对象相对源浏览前缀的路径。
 * sourcePrefix = "config/", key = "config/data/app.json" -> "data/app.json"
 * sourcePrefix = "", key = "config/app.json" -> "config/app.json"
 */
function computeRelativeKey(key: string, sourcePrefix: string): string {
  if (!sourcePrefix) return key
  if (key.startsWith(sourcePrefix)) return key.slice(sourcePrefix.length)
  return key  // fallback：不在前缀下，保留完整 key
}
```

#### 3.4.3 headObject -- 获取对象元数据

新增 `headObject()`（S3 HEAD 请求），用于扫描阶段补全直接勾选对象的 size：

```typescript
export async function headObject(
  instance: MinioInstance, bucket: string, objectKey: string,
): Promise<{ size: number; contentType: string } | null> {
  // HEAD /{bucket}/{key}，签名同 GET 但无 body
  // 返回 Content-Length / Content-Type
  // 404 -> null
}
```

> 这也是提议 9（增量分发）需要的函数，本次先实现供 sync 用。

### 3.5 API 路由

#### 3.5.1 POST /api/sync（server/api/sync/index.post.ts）

```typescript
export default defineEventHandler(async (event) => {
  const body = await readBody<SyncRequest>(event)

  // 1. 校验
  if (!body.source?.instanceId) throw createError({ statusCode: 400, statusMessage: '缺少源实例' })
  if (!body.source?.bucket) throw createError({ statusCode: 400, statusMessage: '缺少源 bucket' })
  if (!body.source?.keys?.length && !body.source?.prefixes?.length)
    throw createError({ statusCode: 400, statusMessage: '未选择源对象' })
  if (!body.targets?.instanceIds?.length) throw createError({ statusCode: 400, statusMessage: '未选择目标实例' })

  // 2. 展开目标实例 + 查找源实例（遍历 groups）
  const groups = await getGroups()
  const targetInstances: MinioInstance[] = []
  let sourceInstance: MinioInstance | null = null
  for (const g of groups) {
    for (const inst of g.instances) {
      if (inst.id === body.source.instanceId) sourceInstance = inst
      if (body.targets.instanceIds.includes(inst.id) && inst.enabled) targetInstances.push(inst)
    }
  }
  if (!sourceInstance) throw createError({ statusCode: 404, statusMessage: '源实例不存在' })

  // 4. 校验源不在目标中
  if (body.targets.instanceIds.includes(body.source.instanceId))
    throw createError({ statusCode: 400, statusMessage: '源实例不能作为同步目标' })

  // 5. 校验所有目标实例有 bucket
  for (const inst of targetInstances) {
    if (!body.targets.instanceBuckets[inst.id])
      throw createError({ statusCode: 400, statusMessage: `实例 ${inst.name} 未指定 bucket` })
  }

  // 6. 创建任务
  const task: SyncTask = {
    id: `sync-${crypto.randomUUID()}`,
    request: body,
    status: 'pending',
    resolvedInstances: targetInstances,
    sourceInstance,
    resolvedFiles: [],
    results: [],
    createdAt: new Date().toISOString(),
  }

  registerSyncTask(task)
  executeSync(task.id).catch(err => {
    // 扫描阶段失败 -> 直接 complete 带错误
    task.status = 'done'
    notifySync(task.id, {
      type: 'complete', taskId: task.id,
      summary: { total: 0, success: 0, failed: 0 },
    })
  })

  return { taskId: task.id }
})
```

#### 3.5.2 GET /api/sync/events（server/api/sync/events.get.ts）

```typescript
export default defineEventHandler(async (event) => {
  const taskId = getQuery(event).taskId as string
  if (!taskId) throw createError({ statusCode: 400, statusMessage: '缺少 taskId' })

  const stream = createEventStream(event)

  const unsubscribe = subscribeSyncTask(taskId, (evt) => {
    stream.push({
      event: evt.type,          // scan-progress | scan-complete | start | progress | complete
      data: JSON.stringify(evt),
    }).catch(() => {})

    if (evt.type === 'complete') {
      stream.close().catch(() => {})
    }
  })

  stream.onClosed(() => { unsubscribe() })
  return stream.send()
})
```

结构与 `server/api/dispatch/events.get.ts` 完全一致，只是事件类型多了 `scan-progress` / `scan-complete`。


### 3.6 前端 composable（app/composables/useSync.ts）

useSync 是第一部分的前端核心，管理同步任务的全生命周期：
- 目标实例选择状态（实例树 + bucket + 前缀）
- 同步进度状态（扫描/同步/完成 + 实例×文件矩阵）
- SSE 订阅（scan-progress / scan-complete / start / progress / complete）
- Modal 开关状态（控制是否展示进度详情，不影响任务执行）

与旧方案的关键差异：**不依赖 URL 参数，不需要 attachTask / 状态恢复**。SSE 连接在任务期间一直保持，Modal 开关只是控制 UI 渲染。

```typescript
export function useSync() {
  // ── 目标端状态（与 useDispatch 同构） ──────────────────
  const targetInstanceIds = ref<Set<string>>(new Set())
  const targetBuckets = ref<Record<string, string>>({})
  const targetBucketOptions = ref<Record<string, BucketLoadState>>({})
  const targetPrefix = ref<string>("")

  // ── 进度状态 ───────────────────────────────────────────
  const isRunning = ref(false)
  const isScanning = ref(false)
  const scannedCount = ref(0)
  const resolvedFiles = ref<SyncFileInfo[]>([])
  const progress = ref<Record<string, CellStatus>>({})  // key = `${instanceId}::${relativeKey}`
  const taskSummary = ref<{ total: number; success: number; failed: number } | null>(null)
  const taskId = ref<string | null>(null)
  let eventSource: EventSource | null = null

  // ── Modal 状态 ─────────────────────────────────────────
  const modalOpen = ref(false)       // Modal 是否打开
  const modalPhase = ref<"select" | "progress" | "done">("select")

  // ── 方法 ───────────────────────────────────────────────
  async function submit(source: SyncSource, groups: InstanceGroup[]) { /* POST /api/sync + subscribeSSE */ }
  function subscribeSSE(tid: string) { /* EventSource 订阅 5 种事件 */ }
  function closeModal() { /* 关 Modal，任务继续跑 */ }
  function reopenModal() { /* 重新打开 Modal，展示当前进度（数据仍在） */ }
  function reset() { /* 完全重置，关闭 SSE */ }

  // ... loadTargetBuckets / getInstanceBucket / getInstanceProgress / cellKey 等（复用 useDispatch 模式）

  return { /* 所有 ref + 方法 */ }
}
```

#### submit 流程

```typescript
async function submit(source: SyncSource, groups: InstanceGroup[]) {
  // 1. 校验目标实例 + bucket
  // 2. POST /api/sync，source 由调用方（browser 页）传入
  const res = await $fetch<{ taskId: string }>("/api/sync", {
    method: "POST",
    body: { source, targets: { instanceIds, instanceBuckets, prefix } },
  })
  taskId.value = res.taskId
  modalPhase.value = "progress"
  subscribeSSE(res.taskId)
}
```

#### SSE 订阅

```typescript
function subscribeSSE(tid: string) {
  isRunning.value = true
  eventSource = new EventSource(`/api/sync/events?taskId=${tid}`)

  eventSource.addEventListener("scan-progress", (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    isScanning.value = true
    scannedCount.value = data.scannedCount
  })

  eventSource.addEventListener("scan-complete", (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    isScanning.value = false
    resolvedFiles.value = data.files
    // 初始化所有 instance×file 为 running
    for (const inst of targetInstances) {
      for (const f of data.files) {
        progress.value[cellKey(inst.id, f.relativeKey)] = "running"
      }
    }
  })

  eventSource.addEventListener("start", () => { /* scanning -> running */ })

  eventSource.addEventListener("progress", (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    if (data.result) {
      progress.value[cellKey(data.result.instanceId, data.result.fileName)] = data.result
    }
  })

  eventSource.addEventListener("complete", (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    taskSummary.value = data.summary
    isRunning.value = false
    modalPhase.value = "done"
    // 兜底：未收到结果的标记 failed
    eventSource?.close()
  })

  eventSource.onerror = () => {
    isRunning.value = false
    isScanning.value = false
    eventSource?.close()
  }
}
```

### 3.7 SyncTargetModal.vue（同步 Modal 组件）

第一部分的核心前端组件，分两个阶段渲染：

```typescript
// Props（来自 browser 页，只读源上下文）
const props = defineProps<{
  open: boolean
  sourceInstanceId: string
  sourceInstanceName: string
  sourceEndpoint: string
  sourceBucket: string
  sourcePrefix: string
  selectedKeys: Set<string>
  selectedPrefixes: Set<string>
}>()

const emit = defineEmits<{
  "update:open": [boolean]
  complete: []  // 任务完成且用户点关闭时，通知父组件刷新对象列表
}>()

// useSync 在父组件（browser 页）实例化，通过 props 传入
// 这样 browser 页和 SyncFloatingIndicator 能访问同一份状态
const props = defineProps<{
  // ... 源上下文 props（同上）
  sync: ReturnType<typeof useSync>  // ← 从父组件传入
}>()
const { data: groups } = await useFetch<InstanceGroup[]>("/api/groups")

// 阶段一（select）：目标实例树 + bucket + 前缀
// 阶段二（progress）：扫描 spinner / 进度矩阵
// 阶段三（done）：汇总 + 关闭按钮

// 底部按钮随阶段变化：
// - select: [取消] [开始同步]
// - progress: [后台继续] [关闭(禁用)]
// - done: [关闭]

async function onSubmit() {
  const source: SyncSource = {
    instanceId: props.sourceInstanceId,
    bucket: props.sourceBucket,
    prefix: props.sourcePrefix,
    keys: [...props.selectedKeys],
    prefixes: [...props.selectedPrefixes],
  }
  await sync.submit(source, groups.value ?? [])
}

function onBackground() {
  // 关闭 Modal，任务后台继续
  sync.modalOpen.value = false
}

function onClose() {
  // 任务完成后关闭 + 刷新列表
  sync.reset()
  emit("update:open", false)
  emit("complete")  // 父组件调 loadObjects()
}
```

**useSync 实例化策略（关键）**：
- `useSync()` 在 browser 页（父组件）调用，返回单例。
- 通过 props 传入 SyncTargetModal，Modal 内部直接读写 sync 的 ref。
- browser 页同时用 sync 的 ref 控制 SyncFloatingIndicator 的显示和「同步到...」按钮的禁用。
- 这样 Modal、悬浮指示器、按钮三处访问的是同一份状态，避免跨组件状态不同步。

**Modal 与悬浮指示器的联动**：
- Modal 由 `showSyncModal`（browser 页 ref）控制，同时检查 `sync.modalPhase` 决定渲染内容。
- 点「后台继续」-> `showSyncModal = false`，但 SSE 不断开，进度数据持续更新。
- 悬浮指示器读 `sync` 的同一份进度数据，显示精简版。
- 点悬浮指示器 -> `showSyncModal = true`，Modal 重新打开，进度视图立刻可用。

### 3.8 悬浮进度指示器（SyncFloatingIndicator.vue）

独立的小组件，固定在页面右下角：

```typescript
// Props（从 useSync 传入）
const props = defineProps<{
  isRunning: boolean
  isScanning: boolean
  scannedCount: number
  taskSummary: { total: number; success: number; failed: number } | null
  completedCount: number  // 已完成数（从 progress 矩阵聚合）
  totalCount: number      // 总数（resolvedFiles.length * 目标实例数）
}>()

const emit = defineEmits<{
  reopen: []  // 点击指示器，重新打开 Modal
}>()
```

**显示规则**：
- `isRunning && !modalOpen` 时显示（Modal 关闭但任务进行中）。
- 全部成功（`taskSummary.failed === 0`）时显示 3 秒后自动淡出。
- 有失败时常驻，用户可手动关闭（放弃查看），关闭后不再出现。

### 3.9 browser/index.vue 改动

```vue
<!-- 工具栏新增（selectedCount > 0 时显示，sync 任务进行中时禁用） -->
<NuxtButton
  v-if="selectedCount > 0"
  size="sm"
  color="primary"
  variant="outline"
  icon="i-lucide-refresh-cw"
  label="同步到..."
  :disabled="syncTaskActive"
  @click="showSyncModal = true"
/>

<!-- 同步 Modal -->
<SyncTargetModal
  v-model:open="showSyncModal"
  :source-instance-id="selectedInstanceId"
  :source-instance-name="inst?.name ?? ""
  :source-endpoint="inst?.endpoint ?? ""
  :source-bucket="selectedBucket"
  :source-prefix="currentPrefix"
  :selected-keys="selectedKeys"
  :selected-prefixes="selectedPrefixes"
  @complete="loadObjects()"
/>

<!-- 悬浮进度指示器 -->
<SyncFloatingIndicator
  v-if="syncTaskActive && !showSyncModal"
  :is-running="syncIsRunning"
  :is-scanning="syncIsScanning"
  :scanned-count="syncScannedCount"
  :task-summary="syncTaskSummary"
  :completed-count="syncCompletedCount"
  :total-count="syncTotalCount"
  @reopen="showSyncModal = true"
/>
```

browser 页调用 `const sync = useSync()` 实例化，传入 SyncTargetModal 作为 prop。
`syncTaskActive` = `sync.isRunning.value || sync.taskSummary.value !== null`（任务进行中或已完成但未重置）。
悬浮指示器在 `syncTaskActive && !showSyncModal && sync.modalPhase !== 'select'` 时显示。



## 四、实施步骤（第一部分：浏览器内同步）

### 步骤 1：后端类型定义

**文件**：`server/types/index.ts`

追加 `SyncSource` / `SyncTarget` / `SyncRequest` / `SyncFileInfo` / `SyncResult` / `SyncTask` / `SyncEvent` 类型定义。

### 步骤 2：minio.ts 流式上传改造

**文件**：`server/utils/minio.ts`

1. 提取 `initiateMultipartUpload` / `uploadPart` / `completeMultipartUpload` 为独立函数（`abortMultipartUpload` 已是独立函数）
2. 新增 `uploadFromStream()` / `uploadSmallFromStream()` / `uploadLargeFromStream()`
3. 新增 `streamToParts()` 流式分片器
4. 新增 `headObject()` 函数（HEAD 请求获取对象元数据）

### 步骤 3：sync 任务框架

**文件**：`server/utils/sync.ts`（新建）

实现 `syncRegistry` / `registerSyncTask` / `subscribeSyncTask` / `notifySync` / `getSyncTask` / `executeSync` / `processInstanceSync` / `computeRelativeKey` / `scanSourceObjects`。克隆 dispatcher.ts 框架，适配扫描 + 同步两阶段语义。

### 步骤 4：API 路由

**文件**：`server/api/sync/index.post.ts` + `server/api/sync/events.get.ts`（新建）

实现提交同步任务 + SSE 进度推送。

### 步骤 5：前端 composable

**文件**：`app/composables/useSync.ts`（新建）

实现目标端状态管理 + submit + SSE 订阅 + 进度聚合 + Modal 状态控制。**不包含**源端选择状态（源由 browser 页提供）、attachTask、URL taskId 模式。

### 步骤 6：同步 Modal 组件

**文件**：`app/components/SyncTargetModal.vue`（新建）

两阶段 Modal：目标选择（实例树 + bucket + 前缀）-> 同步进度（扫描 + 实例×文件矩阵 + 重试）。底部按钮随阶段变化：[取消/开始同步] -> [后台继续/关闭] -> [关闭]。

### 步骤 7：悬浮进度指示器

**文件**：`app/components/SyncFloatingIndicator.vue`（新建）

右下角悬浮指示器，显示精简进度（扫描中/同步中 N/M + 进度条/完成状态）。点击重新打开 Modal。成功自动淡出，有失败常驻。

### 步骤 8：browser 页改动

**文件**：`app/pages/ops/browser/index.vue`（修改）

工具栏新增「同步到...」按钮 + 引入 SyncTargetModal + 引入 SyncFloatingIndicator。任务进行中禁用「同步到...」按钮。

### 步骤 9：手动测试

启动 dev server + 至少 2 个本地 MinIO 容器，验证：

1. browser 浏览 -> 勾选对象 -> 同步到... -> Modal 选目标 -> 开始同步 -> 扫描 -> 进度 -> 完成 -> 关闭 -> 列表刷新
2. 点「后台继续」-> Modal 关闭 -> 右下角悬浮指示器显示进度 -> 点击指示器 -> Modal 重新打开
3. 文件夹前缀递归展开 -> 扫描阶段显示对象数 -> 同步全部
4. 大文件（>8MB）-> 流式 multipart -> 完成
5. 源实例作为目标 -> 禁用 + "源" badge
6. 源对象不存在（404）-> 标记失败
7. 目标 bucket 不存在 -> 标记失败
8. 失败重试 -> 仅重试失败文件
9. 对象超 10000 -> 扫描阶段拦截
10. 全部成功 -> 悬浮指示器 3 秒后淡出；有失败 -> 常驻


## 五、风险与注意事项

| 风险 | 应对 |
|---|---|
| **流式分片精度** | `streamToParts` 用 Buffer 累积确保每片精确 `partSize` 字节（除最后一片）。Web ReadableStream 的 chunk 边界不保证等于 partSize，必须累积切分 |
| **fetch body 流式兼容性** | Node 18+ undici fetch 支持 Web ReadableStream 作为 body。项目运行时为 Node（非 Bun），兼容无问题。但需验证目标端 MinIO 是否接受 chunked transfer（预签名 PUT 用 Content-Length 而非 chunked） |
| **源端 GetObject 超时** | `getObjectStream` 超时 10 分钟（minio.ts:1086），超大文件流式传输可能不够。大文件 multipart 分片时，每个 part 是独立 GetObject Range 请求（避免单连接超时）。**优化**：大文件改用 Range 请求逐片拉取，而非整文件流式 |
| **multipart 函数提取影响现有分发** | 提取是纯重构，`uploadLarge` 行为不变。需回归测试现有分发的大文件上传 |
| **内存控制** | 实例维度并发 5，每实例大文件分片缓冲 8MB，峰值内存 ≈ 5×8MB = 40MB，可接受。如果 PART_SIZE 更大需评估 |
| **扫描阶段对象上限** | `SYNC_SCAN_LIMIT = 10000`，超限抛错。防止用户选了根前缀导致全量扫描 |
| **SSE 连接中断** | onerror 兜底标记未完成项为失败。扫描阶段中断也需处理 |
| **源和目标实例重叠** | API 层校验 + 前端 UI 禁用，双重防护 |
| **目标 key 路径遍历** | `sanitizeObjectKey(targetPrefix + relativeKey)` 复用现有清洗函数（minio.ts:704），过滤 `..` |
| **任务内存易失** | 与 dispatch/cleanup 一致，进程重启丢失。60s 后从内存删除。关闭 Modal 后任务继续，但刷新页面会丢失进度 |

### 5.1 大文件流式传输的超时优化（实现时需注意）

上述风险中"源端 GetObject 超时"需要特别处理。初步设计的 `streamToParts` 是从整文件流读取，但大文件单次 GetObject 连接可能超 10 分钟。

**优化方案**：大文件场景，不使用整文件 `getObjectStream`，而是用 Range 请求逐片拉取：

```
大文件同步流程（优化版）：
  1. headObject 获取 size
  2. initiateMultipartUpload
  3. for each part (1..N):
       a. getObjectStream(source, bucket, key, `bytes=${start}-${end}`)  ← Range 请求
       b. 读出这片 Buffer（≤ PART_SIZE，快速完成）
       c. uploadPart(target, ..., chunk)
  4. completeMultipartUpload
```

这样每个 part 是独立的 Range 请求，不会触发 10 分钟超时。`getObjectStream` 已支持 `rangeHeader` 参数（minio.ts:1100-1102）。

**小文件不受影响**：小文件（<8MB）单次 GetObject + PUT，10 分钟超时足够。

---

## 六、与现有代码的复用对照

| 能力 | 现有实现 | sync 实现 | 复用方式 |
|---|---|---|---|
| 源端拉取 | `getObjectStream`（minio.ts:1061） | 直接调用 | 完全复用 |
| 源端列对象 | `listObjects`（minio.ts:728） | 直接调用 | 完全复用 |
| 目标端上传 | `uploadObject`（minio.ts:443，磁盘路径） | `uploadFromStream`（新增，流式） | 新增流式版，不改动原函数 |
| Multipart 步骤 | 内联在 `uploadLarge`（minio.ts:503-610） | 提取为独立函数后共用 | 重构提取 |
| 任务框架 | `dispatcher.ts` taskRegistry + SSE | `sync.ts` 克隆 | 结构克隆，语义适配 |
| SSE 推送 | `events.get.ts` createEventStream | `sync/events.get.ts` 同构 | 克隆 |
| 进度视图 | dispatch/index.vue 实例级聚合折叠 | SyncTargetModal.vue 进度阶段 | UI 模式复用 |
| 源端选择 UI | browser/index.vue 实例+bucket+前缀+多选 | browser 页已有，Modal 接收 props | 直接复用 |
| 目标端选择 UI | dispatch/index.vue 实例树+bucket+前缀 | SyncTargetModal.vue select 阶段 | 交互模式复用 |
| bucket 加载 | `useDispatch.loadBuckets`（:206-247） | `useSync.loadTargetBuckets` | 模式复用 |
| 实例树渲染 | dispatch/index.vue :260-295 | SyncTargetModal.vue | 模式复用 |
| 对象列表渲染 | browser/index.vue :920-1010 | browser 页已有，不重复 | 直接复用 |
| SSE 订阅 | BrowserUploadModal.vue :327-387 | useSync subscribeSSE | 模式复用 + 新增 scan 事件 |

**结论**：后端核心新增是流式上传函数 + sync 任务框架（克隆），前端核心新增是 useSync composable + SyncTargetModal + SyncFloatingIndicator。useSync 在 browser 页实例化，通过 props 共享给 Modal 和指示器，避免跨组件状态不同步。大量复用现有 UI 交互模式和后端 minio.ts 原子能力，不重复造轮子。
