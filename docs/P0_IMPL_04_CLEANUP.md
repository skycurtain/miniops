# 提议 4 实施计划：跨实例批量清理 + 删除 SSE 进度

> **目标**：实现跨实例批量清理页面（`/ops/cleanup`），支持选多个实例 + bucket + 前缀，SSE 实时推送删除进度。
>
> 配套交互设计文档：`P0_DESIGN_04_CLEANUP.md`

---

## 一、现状分析

### 1.1 现有可复用能力

```
server/utils/minio.ts
  ├ deleteObjects()          ← DeleteMultipleObjects（单批 1000），可直接复用
  ├ deleteByPrefixes()       ← 递归列出 + 分批删除（10000 上限），可直接复用
  ├ listObjects()            ← ListObjectsV2（支持 delimiter/continuationToken），可直接复用
  └ signRequest()            ← 通用 SigV4 签名，无需改动

server/utils/dispatcher.ts
  ├ taskRegistry             ← 内存任务注册表模式（cleanup.ts 参照实现）
  ├ subscribeTask()          ← SSE 订阅 + 迟到连接兜底（cleanup.ts 参照实现）
  ├ notify()                 ← 通知所有订阅者（cleanup.ts 参照实现）
  └ executeDispatch()        ← 实例维度并发 + 信号量模式（cleanup.ts 参照实现）

server/api/dispatch/events.get.ts
  └ createEventStream + subscribeTask 模式（cleanup events 路由参照实现）

server/api/instances/buckets.post.ts
  └ 批量获取 bucket 列表（传 instanceIds[]），预览/交集计算复用

server/utils/store.ts
  └ getGroups()              ← 获取所有实例组（含嵌套实例）

app/composables/useDispatch.ts
  ├ selectedInstanceIds      ← Set<string> 多选模式（cleanup 参照）
  ├ loadBuckets()            ← 批量加载 bucket（cleanup 参照）
  ├ getGroupBucketIntersection() ← bucket 交集计算（cleanup 直接复用思路）
  ├ cellKey()                ← `${instanceId}::${target}` 进度定位（cleanup 参照）
  ├ EventSource 订阅模式     ← start/progress/complete 三事件（cleanup 参照）
  └ getInstanceProgress()    ← 实例级聚合进度（cleanup 参照）

app/components/ConfirmDialog.vue
  └ 二次确认弹窗（清理确认复用）

app/pages/ops/dispatch/index.vue
  ├ 组 + 实例两级 checkbox 选择模式（cleanup 直接参照）
  ├ 实例聚合折叠进度视图（cleanup 直接参照）
  └ bucket 交集下拉（cleanup 直接参照）
```

### 1.2 缺失能力

- `server/utils/cleanup.ts`：清理执行器（任务注册表 + SSE notify + executeCleanup）
- `server/types/index.ts` 新增类型：`CleanupRequest` / `CleanupResult` / `CleanupTask`
- 2 条 API 路由：`POST /api/cleanup` + `GET /api/cleanup/events`
- 1 个前端 composable：`useCleanup.ts`
- 1 个前端页面：`app/pages/ops/cleanup/index.vue`
- 导航入口：`AppLayout.vue` 新增菜单项

**零新增签名代码、零新增 S3 操作函数**，全部复用 minio.ts 现有能力。

### 1.3 前端结构

```
app/
  ├ components/AppLayout.vue          ← 侧边栏导航（新增"批量清理"项）
  ├ components/ConfirmDialog.vue      ← 二次确认弹窗（复用）
  ├ pages/ops/dispatch/index.vue      ← 分发页（实例选择 + 进度视图参考）
  ├ pages/ops/browser/index.vue       ← 对象浏览器（多选 + 前缀导航参考）
  ├ composables/useDispatch.ts        ← 分发逻辑（SSE 订阅 + bucket 加载参考）
  └ composables/useCleanup.ts         ← 新建：清理逻辑 composable
```

---

## 二、改动清单

### 2.1 后端

| 文件 | 操作 | 说明 |
|---|---|---|
| `server/types/index.ts` | 修改 | 新增 `CleanupRequest` / `CleanupResult` / `CleanupTask` 类型 |
| `server/utils/cleanup.ts` | 新建 | 清理执行器（任务注册表 + SSE notify + executeCleanup） |
| `server/api/cleanup/index.post.ts` | 新建 | `POST /api/cleanup` 提交清理任务 |
| `server/api/cleanup/events.get.ts` | 新建 | `GET /api/cleanup/events` SSE 端点 |

### 2.2 前端

| 文件 | 操作 | 说明 |
|---|---|---|
| `app/components/AppLayout.vue` | 修改 | navItems「运维」下新增「批量清理」 |
| `app/composables/useCleanup.ts` | 新建 | 清理状态管理 + SSE 订阅 composable |
| `app/pages/ops/cleanup/index.vue` | 新建 | 批量清理页面 |

**总计：后端 1 改 3 新，前端 1 改 2 新。零新增依赖。**

---

## 三、实施步骤

### 步骤 1：后端类型定义

**文件**：`server/types/index.ts`

在文件末尾（`DeleteObjectsResult` 之后）新增：

```typescript
// ---------- 批量清理相关类型 ----------

/** 清理任务请求 */
export interface CleanupRequest {
  /** 目标实例 ID 列表 */
  instanceIds: string[]
  /** 目标 bucket（所有实例共用） */
  bucket: string
  /** 前缀（留空 = bucket 根） */
  prefix?: string
  /** 是否递归删除子前缀（无 keys/prefixes 时生效） */
  recursive?: boolean
  /** 要删除的具体对象 key 列表（来自预览勾选，可选） */
  keys?: string[]
  /** 要递归删除的文件夹前缀列表（来自预览勾选，可选） */
  prefixes?: string[]
}

/** 单个对象/前缀清理结果 */
export interface CleanupResult {
  instanceId: string
  instanceName: string
  /** 对象 key 或文件夹前缀 */
  target: string
  /** 是文件夹前缀还是单个对象 */
  targetType: 'object' | 'prefix'
  status: 'success' | 'failed'
  error?: string
  /** 删除的对象数（文件夹递归时可能 >1） */
  deletedCount?: number
  /** 耗时（毫秒） */
  duration?: number
}

/** 清理任务 */
export interface CleanupTask {
  id: string
  request: CleanupRequest
  status: 'pending' | 'running' | 'done'
  /** 展开后的目标实例列表（去重后，仅 enabled） */
  resolvedInstances: MinioInstance[]
  results: CleanupResult[]
  createdAt: string
  finishedAt?: string
}
```

**验证**：类型定义无编译错误（依赖 `MinioInstance`，已在本文件中定义）。

---

### 步骤 2：后端清理执行器

**文件**：`server/utils/cleanup.ts`（新建）

参照 `dispatcher.ts` 的结构，实现清理执行器。

**核心结构**：

```typescript
import type { CleanupResult, CleanupTask, MinioInstance } from '../types'
import { deleteObjects, deleteByPrefixes, listObjects } from './minio'

/** 并发数，可通过 CLEANUP_CONCURRENCY 环境变量配置 */
const CONCURRENCY = Number(process.env.CLEANUP_CONCURRENCY) || 5

// ---------- 任务注册表 ----------

interface TaskEntry {
  task: CleanupTask
  subscribers: Array<(event: { type: string; taskId: string; result?: CleanupResult; summary?: { total: number; success: number; failed: number } }) => void>
}

const taskRegistry = new Map<string, TaskEntry>()

/** 注册任务 */
export function registerCleanupTask(task: CleanupTask): void {
  taskRegistry.set(task.id, { task, subscribers: [] })
}

/** 订阅任务事件（SSE 连接调用） */
export function subscribeCleanupTask(
  taskId: string,
  callback: TaskEntry['subscribers'][number],
): () => void {
  // 逻辑与 dispatcher.ts subscribeTask 完全对称：
  // - 任务已完成 -> 立即推送 complete 事件
  // - 否则加入 subscribers 列表
  // - 返回取消订阅函数
  ...
}

/** 通知所有订阅者 */
function notify(taskId: string, event: { ... }): void {
  // 与 dispatcher.ts notify 完全对称
  ...
}

/** 获取任务 */
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

  // 信号量并发控制（与 executeDispatch 完全对称的模式）
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

  // 延迟清理任务注册表（保留 60s）
  setTimeout(() => taskRegistry.delete(task.id), 60_000)
}
```

**`processInstanceCleanup` 详细逻辑**：

```typescript
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
  keys?: string[],
  prefixes?: string[],
  prefix?: string,
  recursive?: boolean,
): Promise<void> {
  const task = taskRegistry.get(taskId)!.task

  // ---------- 模式 A：精确勾选 ----------
  if (keys?.length || prefixes?.length) {
    // 1. 删除精确对象（分批 1000）
    if (keys?.length) {
      const start = Date.now()
      try {
        const allDeleted: string[] = []
        const allErrors: { key: string, error: string }[] = []
        for (let i = 0; i < keys.length; i += 1000) {
          const batch = keys.slice(i, i + 1000)
          const result = await deleteObjects(instance, bucket, batch)
          allDeleted.push(...result.deleted)
          allErrors.push(...result.errors)
        }
        // 精确模式：每个 key 推一个 result
        for (const key of keys) {
          const err = allErrors.find(e => e.key === key)
          const result: CleanupResult = {
            instanceId: instance.id,
            instanceName: instance.name,
            target: key,
            targetType: 'object',
            status: err ? 'failed' : 'success',
            error: err?.error,
            duration: Date.now() - start,
          }
          task.results.push(result)
          notify(taskId, { type: 'progress', taskId, result })
        }
      } catch (e: any) {
        // 整体异常：所有 key 标记失败
        for (const key of keys) {
          const result: CleanupResult = {
            instanceId: instance.id, instanceName: instance.name,
            target: key, targetType: 'object',
            status: 'failed', error: e?.message || '删除失败',
          }
          task.results.push(result)
          notify(taskId, { type: 'progress', taskId, result })
        }
      }
    }

    // 2. 删除文件夹前缀（逐个 deleteByPrefixes）
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
        } catch (e: any) {
          result.status = 'failed'
          result.error = e?.message || '递归删除失败'
          result.duration = Date.now() - start
        }
        task.results.push(result)
        notify(taskId, { type: 'progress', taskId, result })
      }
    }
    return
  }

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
    } catch (e: any) {
      result.status = 'failed'
      result.error = e?.message || '递归删除失败'
      result.duration = Date.now() - start
    }
    task.results.push(result)
    notify(taskId, { type: 'progress', taskId, result })
  } else {
    // 非递归：listObjects(delimiter='/') -> 只删 Contents 的 key
    const start = Date.now()
    try {
      const allKeys: string[] = []
      let token: string | undefined
      do {
        const listResult = await listObjects(instance, bucket, effectivePrefix, '/', token)
        if (listResult.error) {
          const result: CleanupResult = {
            instanceId: instance.id, instanceName: instance.name,
            target: effectivePrefix || '/', targetType: 'prefix',
            status: 'failed', error: `列出对象失败: ${listResult.error}`,
          }
          task.results.push(result)
          notify(taskId, { type: 'progress', taskId, result })
          return
        }
        allKeys.push(...listResult.objects.map(o => o.key))
        token = listResult.isTruncated ? listResult.continuationToken : undefined
      } while (token)

      // 分批删除
      const allDeleted: string[] = []
      const allErrors: { key: string, error: string }[] = []
      for (let i = 0; i < allKeys.length; i += 1000) {
        const batch = allKeys.slice(i, i + 1000)
        const delResult = await deleteObjects(instance, bucket, batch)
        allDeleted.push(...delResult.deleted)
        allErrors.push(...delResult.errors)
      }

      const result: CleanupResult = {
        instanceId: instance.id, instanceName: instance.name,
        target: effectivePrefix || '/', targetType: 'prefix',
        status: allErrors.length ? 'failed' : 'success',
        deletedCount: allDeleted.length,
        error: allErrors[0]?.error,
        duration: Date.now() - start,
      }
      task.results.push(result)
      notify(taskId, { type: 'progress', taskId, result })
    } catch (e: any) {
      const result: CleanupResult = {
        instanceId: instance.id, instanceName: instance.name,
        target: effectivePrefix || '/', targetType: 'prefix',
        status: 'failed', error: e?.message || '删除失败',
        duration: Date.now() - start,
      }
      task.results.push(result)
      notify(taskId, { type: 'progress', taskId, result })
    }
  }
}
```

**验证**：
- `nuxt typecheck` 或 dev server 启动无类型错误
- 手动验证：在 cleanup.ts 中 import 的 `deleteObjects` / `deleteByPrefixes` / `listObjects` 均在 minio.ts 中已 export

---

### 步骤 3：后端 API 路由

#### 3.1 `POST /api/cleanup`（`server/api/cleanup/index.post.ts`）

参照 `server/api/dispatch/index.post.ts` 的模式：

```typescript
import { getGroups } from '../../utils/store'
import { registerCleanupTask, executeCleanup } from '../../utils/cleanup'
import type { CleanupRequest, CleanupTask, MinioInstance } from '../../types'

/**
 * POST /api/cleanup
 * 提交清理任务。后端立即创建任务并返回 taskId，后台异步执行。
 *
 * 请求体: CleanupRequest
 * 响应: 202 Accepted { taskId: "cleanup-xxx" }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<CleanupRequest>(event)

  // 基本校验
  if (!body?.instanceIds?.length) {
    throw createError({ statusCode: 400, statusMessage: '至少选择一个目标实例' })
  }
  if (!body?.bucket) {
    throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  }
  // 精确模式需要 keys 或 prefixes；按前缀模式需要 prefix 或显式空（清空 bucket）
  if (!body.keys?.length && !body.prefixes?.length) {
    // 按前缀全删模式：prefix 未传则视为清空 bucket 根（高危，但允许）
    // recursive 默认 true
    if (body.recursive === undefined) body.recursive = true
  }

  // 从所有组中查找选中的实例（跨组查找，仅 enabled）
  const allGroups = await getGroups()
  const resolvedMap = new Map<string, MinioInstance>()
  for (const g of allGroups) {
    for (const inst of g.instances) {
      if (body.instanceIds.includes(inst.id) && inst.enabled) {
        resolvedMap.set(inst.id, inst)
      }
    }
  }
  if (resolvedMap.size === 0) {
    throw createError({ statusCode: 400, statusMessage: '选中的目标没有启用的实例' })
  }

  // 创建任务
  const task: CleanupTask = {
    id: `cleanup-${crypto.randomUUID()}`,
    request: body,
    status: 'pending',
    resolvedInstances: Array.from(resolvedMap.values()),
    results: [],
    createdAt: new Date().toISOString(),
  }

  registerCleanupTask(task)

  // 后台异步执行（不 await，立即返回 taskId）
  executeCleanup(task).catch((e) => {
    console.error(`[cleanup] 任务 ${task.id} 执行异常:`, e)
  })

  setResponseStatus(event, 202)
  return { taskId: task.id }
})
```

#### 3.2 `GET /api/cleanup/events`（`server/api/cleanup/events.get.ts`）

参照 `server/api/dispatch/events.get.ts`：

```typescript
import { subscribeCleanupTask } from '../../utils/cleanup'

/**
 * GET /api/cleanup/events?taskId=xxx
 * SSE 流，实时推送清理进度。
 *
 * 事件格式:
 *   event: start     data: {"type":"start","taskId":"..."}
 *   event: progress  data: {"type":"progress","taskId":"...","result":{...}}
 *   event: complete  data: {"type":"complete","taskId":"...","summary":{...}}
 */
export default defineEventHandler(async (event) => {
  const taskId = getQuery(event).taskId as string | undefined
  if (!taskId) {
    throw createError({ statusCode: 400, statusMessage: '缺少 taskId 参数' })
  }

  const stream = createEventStream(event)

  const unsubscribe = subscribeCleanupTask(taskId, (evt) => {
    stream.push({
      event: evt.type,
      data: JSON.stringify(evt),
    }).catch(() => {})

    if (evt.type === 'complete') {
      stream.close().catch(() => {})
    }
  })

  stream.onClosed(() => {
    unsubscribe()
  })

  return stream.send()
})
```

**验证**：
- dev server 启动，`POST /api/cleanup` 返回 202 + taskId
- `GET /api/cleanup/events?taskId=xxx` 能建立 SSE 连接

---

### 步骤 4：前端 composable

**文件**：`app/composables/useCleanup.ts`（新建）

参照 `useDispatch.ts` 的模式，实现清理状态管理 + SSE 订阅。

**核心结构**：

```typescript
interface MinioInstance { id: string; groupId: string; name: string; endpoint: string; enabled: boolean }
interface InstanceGroup { id: string; name: string; instances: MinioInstance[]; isDefault?: boolean }
interface ObjectInfo { key: string; size: number; lastModified: string; etag?: string }
interface ListObjectsResult { objects: ObjectInfo[]; commonPrefixes: string[]; isTruncated: boolean; continuationToken?: string }
interface CleanupResult {
  instanceId: string; instanceName: string; target: string;
  targetType: 'object' | 'prefix'; status: 'success' | 'failed';
  error?: string; deletedCount?: number; duration?: number;
}

type CellStatus = CleanupResult | 'running' | null

interface BucketLoadState { buckets: string[]; loading: boolean; error?: string }

export function useCleanup() {
  const selectedInstanceIds = ref<Set<string>>(new Set())
  const selectedBucket = ref<string>('')
  const prefix = ref<string>('')
  const recursive = ref<boolean>(true)

  // 预览状态
  const previewObjects = ref<ObjectInfo[]>([])
  const previewPrefixes = ref<string[]>([])
  const selectedKeys = ref<Set<string>>(new Set())
  const selectedPrefixes = ref<Set<string>>(new Set())
  const previewContinuationToken = ref<string | undefined>(undefined)
  const previewLoading = ref(false)
  const previewError = ref<string>('')
  const previewReferenceInstanceId = ref<string>('')

  // bucket 加载（复用 useDispatch 的 loadBuckets 思路）
  const instanceBucketOptions = ref<Record<string, BucketLoadState>>({})

  // 进度
  const progress = ref<Record<string, CellStatus>>({})
  const isRunning = ref(false)
  const taskSummary = ref<{ total: number; success: number; failed: number } | null>(null)
  let eventSource: EventSource | null = null

  function cellKey(instanceId: string, target: string): string {
    return `${instanceId}::${target}`
  }

  function getCell(instanceId: string, target: string): CellStatus {
    return progress.value[cellKey(instanceId, target)] ?? null
  }

  function getSelectedInstances(groups: InstanceGroup[]): MinioInstance[] {
    // 与 useDispatch.getSelectedInstances 完全相同的模式
    ...
  }

  // ---------- Bucket 加载 ----------
  async function loadBuckets(groups: InstanceGroup[]) {
    // 与 useDispatch.loadBuckets 完全相同的模式
    // POST /api/instances/buckets，批量获取选中实例的 bucket 列表
    ...
  }

  /** 选中实例的 bucket 交集 */
  function getBucketIntersection(groups: InstanceGroup[]): string[] {
    // 与 useDispatch.getGroupBucketIntersection 思路相同，但跨所有选中实例
    ...
  }

  // ---------- 预览 ----------
  async function loadPreview(instanceId: string, token?: string) {
    // POST /api/instances/objects/list，以指定实例为参考加载对象列表
    // 支持分页（continuationToken）
    ...
  }

  // ---------- 提交清理 ----------
  async function submit(groups: InstanceGroup[]) {
    if (isRunning.value) return

    const selected = getSelectedInstances(groups)
    if (!selected.length) { /* toast 提醒 */ return }
    if (!selectedBucket.value) { /* toast 提醒 */ return }

    // 构建请求体
    const body: any = {
      instanceIds: selected.map(i => i.id),
      bucket: selectedBucket.value,
      prefix: prefix.value || undefined,
      recursive: recursive.value,
    }

    // 精确模式：带 keys + prefixes
    if (selectedKeys.value.size || selectedPrefixes.value.size) {
      body.keys = Array.from(selectedKeys.value)
      body.prefixes = Array.from(selectedPrefixes.value)
    }

    progress.value = {}
    taskSummary.value = null
    isRunning.value = true

    const toast = useToast()
    try {
      const res = await $fetch<{ taskId: string }>('/api/cleanup', {
        method: 'POST',
        body,
      })

      eventSource = new EventSource(`/api/cleanup/events?taskId=${res.taskId}`)

      eventSource.addEventListener('start', () => {
        // 标记所有目标为 running
        const targets = body.keys ?? [body.prefix || '/']
        for (const inst of selected) {
          for (const t of targets) {
            progress.value[cellKey(inst.id, t)] = 'running'
          }
        }
      })

      eventSource.addEventListener('progress', (e: MessageEvent) => {
        const data = JSON.parse(e.data)
        if (data.result) {
          progress.value[cellKey(data.result.instanceId, data.result.target)] = data.result
        }
      })

      eventSource.addEventListener('complete', (e: MessageEvent) => {
        const data = JSON.parse(e.data)
        taskSummary.value = data.summary
        isRunning.value = false
        eventSource?.close()
        eventSource = null

        toast.add({
          title: '清理完成',
          description: `共 ${data.summary.total} 个操作，成功 ${data.summary.success}，失败 ${data.summary.failed}`,
          color: data.summary.failed > 0 ? 'warning' : 'success',
        })
      })

      eventSource.onerror = () => {
        if (isRunning.value) {
          isRunning.value = false
          toast.add({ title: '连接中断', description: 'SSE 连接异常，进度可能不完整', color: 'error' })
        }
        eventSource?.close()
        eventSource = null
      }
    } catch (e: any) {
      isRunning.value = false
      toast.add({ title: '清理失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
    }
  }

  function cancel() {
    eventSource?.close()
    eventSource = null
    isRunning.value = false
  }

  /** 实例级聚合进度 */
  function getInstanceProgress(instanceId: string, targets: string[]) {
    let completed = 0
    let failed = 0
    for (const t of targets) {
      const cell = progress.value[cellKey(instanceId, t)]
      if (cell && cell !== 'running') {
        completed++
        if (typeof cell === 'object' && cell.status === 'failed') failed++
      }
    }
    return { completed, total: targets.length, failed }
  }

  return {
    selectedInstanceIds, selectedBucket, prefix, recursive,
    previewObjects, previewPrefixes, selectedKeys, selectedPrefixes,
    previewContinuationToken, previewLoading, previewError, previewReferenceInstanceId,
    instanceBucketOptions,
    progress, isRunning, taskSummary,
    cellKey, getCell, getSelectedInstances,
    loadBuckets, getBucketIntersection, loadPreview,
    submit, cancel, getInstanceProgress,
  }
}
```

**验证**：composable 导出完整，无类型错误。

---

### 步骤 5：前端页面

**文件**：`app/pages/ops/cleanup/index.vue`（新建）

参照分发页的实例选择 + 对象浏览器的多选模式 + 分发页的进度视图。

**页面结构**（6 个区块）：

```vue
<script setup lang="ts">
// 类型定义（与后端对齐）
// useFetch /api/groups 获取实例组
// const cleanup = useCleanup()

// ---------- 实例选择（复用分发页模式）----------
// isInstanceSelected / toggleInstance / isGroupAllSelected / toggleGroup
// watch selectedInstanceIds -> loadBuckets

// ---------- Bucket 交集 ----------
// bucketIntersection = computed -> cleanup.getBucketIntersection(groups)
// bucket 加载失败兜底：手动输入

// ---------- 前缀过滤 ----------
// prefixInput + recursive checkbox
// sanitizePrefix: 复用 sanitizeObjectKey 规则（反斜杠归一化、去段首点、过滤 ..、补尾斜杠）

// ---------- 预览 ----------
// previewReferenceInstanceId 下拉（默认第一个选中实例）
// loadPreview(referenceInstanceId) -> POST /api/instances/objects/list
// 预览对象列表：checkbox 多选（对象 selectedKeys + 文件夹 selectedPrefixes）
// 分页：加载更多

// ---------- 执行确认 ----------
// buildConfirmDescription(): 构建确认弹窗信息
// 高危检测：无前缀 = 清空 bucket -> 需输入 bucket 名确认
// ConfirmDialog

// ---------- 进度视图 ----------
// 实例级折叠（复用分发页模式）
// 每个实例行：实例名 + endpoint + 完成数/总数 + 进度条 + 失败计数
// 展开后：每个 target 的状态（✅/⏳/❌/⬜）
// 完成后：摘要 + 失败明细
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 页头 -->
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-bold text-highlighted">批量清理</h1>
      <p class="text-muted">跨实例批量删除 MinIO 对象，支持按前缀递归清理</p>
    </div>

    <!-- 1. 选实例（组折叠 + checkbox 两级，与分发页一致）-->
    <!-- 2. 选 bucket（交集下拉 + 手动输入兜底）-->
    <!-- 3. 前缀过滤 + 递归开关 + 预览按钮 -->
    <!-- 4. 预览对象列表（可选，参照对象浏览器的多选模式）-->
    <!-- 5. 执行栏（开始清理按钮 + 统计信息）-->
    <!-- 6. 进度区（SSE，实例级折叠，参照分发页进度视图）-->
  </div>
</template>
```

**关键交互实现**：

1. **实例选择**：直接参照 `dispatch/index.vue` 的组 + 实例两级 checkbox 模式（`toggleGroup` / `isGroupAllSelected` / `isGroupPartialSelected` / `toggleInstance`）。

2. **Bucket 交集下拉**：
   ```vue
   <NuxtSelectMenu
     v-model="cleanup.selectedBucket.value"
     :items="bucketIntersection.map(b => ({ label: b, value: b }))"
     value-key="value"
     placeholder="选择 bucket（选中实例的公共 bucket）"
   />
   ```
   交集为空时显示提示。加载失败时显示 ⚠ + 手动输入（与对象浏览器一致）。

3. **前缀输入 + 清洗**：
   ```ts
   function sanitizePrefix(p: string): string {
     const cleaned = p.replace(/\\/g, '/')
       .split('/').map(seg => seg.replace(/^\.+/, ''))
       .filter(seg => seg.length > 0 && seg !== '..').join('/')
     return cleaned ? `${cleaned}/` : ''
   }
   ```

4. **预览对象列表**：参照 `browser/index.vue` 的多选模式（`toggleSelect` / `toggleSelectPrefix` / `toggleSelectAll` / `selectedCount`）。

5. **确认弹窗**：
   ```ts
   async function startCleanup() {
     const overlay = useOverlay()
     const modal = overlay.create(ConfirmDialog, { destroyOnClose: true })

     // 高危检测：无前缀 = 清空 bucket
     const isHighRisk = !cleanup.prefix.value && !cleanup.selectedKeys.value.size && !cleanup.selectedPrefixes.value.size

     if (isHighRisk) {
       // 高危确认：需输入 bucket 名
       // ... 额外校验逻辑
     }

     const confirm = await modal.open({
       title: '确认清理',
       description: buildConfirmDescription(),
       confirmText: '确认清理',
       confirmColor: 'error',
       confirmIcon: 'i-lucide-trash-2',
     })
     if (!confirm) return

     await cleanup.submit(groups.value ?? [])
   }
   ```

6. **进度视图**：参照 `dispatch/index.vue` 的进度区（实例级折叠 + `getInstanceProgress` + `NuxtProgress` + 展开后逐项状态）。

**验证**：
- 页面渲染无错误
- 实例选择 -> bucket 交集加载 -> 前缀输入 -> 预览 -> 确认弹窗 -> 进度展示 完整流程走通

---

### 步骤 6：导航入口

**文件**：`app/components/AppLayout.vue`

修改 navItems，在「运维」children 中新增「批量清理」：

```typescript
const navItems = [
  { label: '总览', to: '/', icon: 'i-lucide-layout-dashboard' },
  { label: '实例', to: '/groups', icon: 'i-lucide-server' },
  {
    label: '运维',
    icon: 'i-lucide-wrench',
    defaultOpen: true,
    children: [
      { label: '文件分发', to: '/ops/dispatch', icon: 'i-lucide-send' },
      { label: '对象浏览', to: '/ops/browser', icon: 'i-lucide-folder-search' },
      { label: '批量清理', to: '/ops/cleanup', icon: 'i-lucide-trash-2' },  // 新增
    ],
  },
]
```

**验证**：侧边栏出现「批量清理」菜单项，点击跳转到 `/ops/cleanup`。

---

## 四、端到端验证

### 4.1 准备

- 启动 dev server：`bun run dev`
- 启动本地 MinIO 容器（至少 2 个实例，或 1 个实例配 2 个 bucket 测试）
- 在实例管理页配置 2+ 个实例，确保有公共 bucket

### 4.2 测试用例

| # | 场景 | 操作 | 预期 |
|---|---|---|---|
| 1 | 精确勾选模式 | 选 2 实例 -> 选 bucket -> 输入前缀 -> 预览 -> 勾选 2 个对象 -> 确认清理 | SSE 推送 4 个 progress（2 实例 × 2 对象），全部成功，完成摘要正确 |
| 2 | 按前缀全删（递归） | 选 2 实例 -> 选 bucket -> 输入前缀 -> 不预览 -> 确认清理 | SSE 推送 2 个 progress（每实例 1 个 prefix 结果），deletedCount > 0 |
| 3 | 按前缀全删（非递归） | 同上但取消递归勾选 | 只删当前层直接对象，不删子前缀 |
| 4 | 无前缀高危清理 | 选实例 -> 选 bucket -> 不填前缀 -> 确认 | 弹出高危确认（需输入 bucket 名），确认后清空 bucket |
| 5 | 部分失败 | 选 2 实例（1 个凭据故意错误）-> 清理 | 失败实例标记 failed + 错误信息，成功实例正常完成，摘要 failed > 0 |
| 6 | bucket 交集为空 | 选 2 个没有公共 bucket 的实例 | bucket 下拉为空 + 提示信息 |
| 7 | 预览分页 | 前缀下对象 > 1000 个 | 加载更多按钮正常追加 |
| 8 | SSE 迟到连接 | 清理开始后延迟 5s 再连 SSE | 立即收到已有 progress + 后续新增 |
| 9 | 取消 | 清理进行中点取消 | SSE 断开，进度停止（后端继续执行，前端不再接收） |

### 4.3 边界检查

- 递归删除超 10000 对象 -> 该前缀标记 failed + 错误信息
- 空实例选择 -> 提交按钮 disabled / toast 提醒
- 空 bucket -> 提交按钮 disabled
- 空前缀 + 无勾选 -> 高危确认弹窗

---

## 五、不改动清单

| 文件 | 原因 |
|---|---|
| `server/utils/minio.ts` | `deleteObjects` / `deleteByPrefixes` / `listObjects` 全部复用，不改动 |
| `server/api/instances/objects/*` | 对象浏览器 API 保持不变 |
| `server/utils/dispatcher.ts` | 分发执行器不改动 |
| `server/api/dispatch/*` | 分发 API 不改动 |
| `app/pages/ops/browser/index.vue` | 对象浏览器不改动（SSE 仅用于跨实例清理） |
| `app/pages/ops/dispatch/index.vue` | 分发页不改动 |
| `app/composables/useDispatch.ts` | 分发 composable 不改动 |
