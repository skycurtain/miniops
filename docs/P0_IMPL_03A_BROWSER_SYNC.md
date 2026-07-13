# 提议 3A 实施计划：浏览器内实例间文件同步

> **目标**：在对象浏览器 `/ops/browser` 中勾选对象后，直接同步到其他 MinIO 实例。Modal 内完成目标选择和进度展示，关闭 Modal 后悬浮指示器保持进度可见。
>
> 配套交互设计文档：`P0_DESIGN_03A_BROWSER_SYNC.md`
>
> 后端共用方案参考：`P0_IMPL_03_SYNC.md`（类型定义、minio.ts 流式上传、sync.ts 任务框架、API 路由）

---

## 一、上次实现踩坑记录（本次必须避免）

上次实现失败的根因是"浏览器快捷入口 -> 跳转独立页面 -> URL taskId 恢复状态"这条链路太复杂：

1. **缺少 `GET /api/sync/:id` 路由**：`attachTask` 请求了不存在的路由。
2. **状态恢复与 watchers 冲突**：`attachTask` 设置 `sourceInstanceId` 触发了页面的 `watch(sourceInstanceId)` -> `loadSourceBuckets()` -> 清空 `sourceBucket`。即使加了 `isRestoring` 标志，Vue 的异步 watch 触发时序仍不可控。
3. **重试时 sourceBucket 已被清空**：上面连锁反应导致 `sourceBucket` 为空，重试提交到后端时 `source.bucket` 为空。

**本次方案彻底消除这些问题**：
- **不跳转页面**：Modal 自包含，不使用 URL 参数，不需要 `attachTask`，不需要状态恢复。
- **SSE 连接持续不断**：关闭 Modal 时不关闭 EventSource，重新打开时无需重新订阅。悬浮指示器和 Modal 读同一份数据。
- **源上下文来自 Props**：Modal 的源信息全部从 browser 页的 props 传入（只读），Modal 内部不维护源选择状态，不会有 watcher 冲突。

---

## 二、改动清单

### 2.1 后端（与 3B 共用，本次完整实现）

| 文件 | 操作 | 说明 |
|---|---|---|
| `server/types/index.ts` | 修改 | 新增 7 个 sync 类型 |
| `server/utils/minio.ts` | 修改 | 提取 multipart 函数 + 新增 uploadFromStream/streamToParts/headObject |
| `server/utils/sync.ts` | 新建 | sync 任务框架（克隆 dispatcher.ts） |
| `server/api/sync/index.post.ts` | 新建 | POST /api/sync |
| `server/api/sync/events.get.ts` | 新建 | GET /api/sync/events SSE |

### 2.2 前端（仅 3A 部分）

| 文件 | 操作 | 说明 |
|---|---|---|
| `app/composables/useSyncTask.ts` | 新建 | 同步任务状态管理 + SSE 订阅（**不维护源/目标选择状态**，只管理任务执行和进度） |
| `app/components/SyncModal.vue` | 新建 | 同步 Modal（目标选择 + 进度展示，两阶段切换） |
| `app/components/SyncFloatingIndicator.vue` | 新建 | 悬浮进度指示器（右下角固定） |
| `app/pages/ops/browser/index.vue` | 修改 | 工具栏新增"同步到..."按钮 + 引入 Modal 和指示器 |

**不需要的文件（与上次对比）**：
- ~~`app/composables/useSync.ts`~~（上次错误地把源/目标选择状态放进了 composable，导致 watcher 冲突）
- ~~`app/pages/ops/sync/index.vue`~~（第二部分）
- ~~`app/components/SyncTargetModal.vue`~~（上次的跳转方案，已废弃）
- ~~`server/api/sync/[id].get.ts`~~（不需要状态恢复，不需要查任务详情）
- ~~AppLayout.vue 导航项~~（第二部分）

---

## 三、后端设计

后端与 `P0_IMPL_03_SYNC.md` 中描述完全一致，此处补充实现时需注意的细节。

### 3.1 类型定义（server/types/index.ts）

在 `CleanupRequest` 之前追加 7 个类型：`SyncSource`、`SyncTarget`、`SyncRequest`、`SyncFileInfo`、`SyncResult`、`SyncTask`、`SyncEvent`。

**关键字段说明**：
- `SyncResult` 与 `DispatchResult` 同构（instanceId/instanceName/fileName/status/error/duration），前端进度视图可直接复用。
- `SyncTask.status` 比 DispatchTask 多 `'scanning'` 阶段。
- `SyncFileInfo.relativeKey`：去掉源浏览前缀后的相对路径，用于目标 key 拼接。

### 3.2 minio.ts 流式上传

**提取 multipart 函数**：从 `uploadLarge`（约 L503-610）内联代码提取 4 个独立函数：
- `initiateMultipartUpload(instance, endpoint, path, contentType) -> uploadId`
- `uploadPartFromBuffer(instance, endpoint, path, uploadId, partNumber, chunk) -> etag`
- `completeMultipartUpload(instance, endpoint, path, uploadId, parts) -> void`
- `abortMultipartUpload` 已是独立函数（L616），无需提取。

**重构 `uploadLarge`**：改为调用提取的函数，行为不变。这是纯重构，不影响现有分发。

**新增函数**：
- `uploadFromStream(instance, bucket, objectKey, stream, size, contentType)` - 统一入口，按 size 分流
- `uploadSmallFromStream` - Web ReadableStream 直接作为 fetch body（undici 支持），加 Content-Length header
- `uploadLargeFromStream` - 用 `streamToParts` 切分 + 逐片 `uploadPartFromBuffer`
- `streamToParts(stream, partSize)` - async generator，累积到 partSize 后 yield Buffer
- `headObject(instance, bucket, objectKey)` - HEAD 请求，返回 {size, contentType} 或 null

**类型注意**：`uploadPartFromBuffer` 的 `chunk` 参数类型用 `Uint8Array`（不是 `Buffer`），`body: chunk as BodyInit` 解决 fetch body 类型兼容性。详见上次实现中的修复。

### 3.3 sync.ts 任务框架

克隆 dispatcher.ts 结构，关键差异：

1. **两阶段执行**：`executeSync` 先 `scanning`（递归展开前缀 + headObject 补全 size），再 `running`（实例维度并发同步）。
2. **扫描阶段 SSE 事件**：`scan-progress`（多次推送已发现数）、`scan-complete`（推送完整文件列表 + 总数 + 总大小）。
3. **`processInstanceSync`**：从源 `getObjectStream` -> `uploadFromStream` 流式直传，从源响应头取 content-length/content-type。
4. **`computeRelativeKey`**：`key.startsWith(sourcePrefix) ? key.slice(sourcePrefix.length) : key`。
5. **扫描失败处理**：catch 中设 `status='done'` + 推 `complete`（空 summary），让前端显示错误。
6. **延迟清理**：`setTimeout(() => syncRegistry.delete(taskId), 60_000)`，与 dispatcher 一致。

### 3.4 API 路由

**POST /api/sync（index.post.ts）**：
- 从 `getGroups()` 展开目标实例 + 查找源实例
- 校验：源不在目标中、所有目标实例有 bucket
- 创建 `SyncTask`，`registerSyncTask` + 异步 `executeSync`
- 返回 `{ taskId }` + 202

**GET /api/sync/events（events.get.ts）**：
- `createEventStream` + `subscribeSyncTask`
- 推送所有事件类型（含 scan-progress/scan-complete）
- complete 后关闭流

---

## 四、前端设计

### 4.1 架构决策：状态管理放在哪里

**上次错误**：把源选择、目标选择、任务进度全部放进 `useSync` composable，导致 composable 职责过重且 watcher 冲突。

**本次方案**：分层管理：

```
app/pages/ops/browser/index.vue（父页面）
  │
  ├ 持有源上下文：selectedInstanceId, selectedBucket, currentPrefix, selectedKeys, selectedPrefixes
  │  （这些已存在，browser 页原本就有）
  │
  ├ 工具栏新增 [同步到...] 按钮，点击后 showSyncModal = true
  │
  ├ <SyncModal> 子组件
  │    ├ props: open, sourceInstanceId, sourceInstanceName, sourceEndpoint,
  │    │         sourceBucket, sourcePrefix, selectedKeys, selectedPrefixes
  │    ├ 内部管理：目标实例选择（targetInstanceIds, targetBuckets, targetPrefix）
  │    │           + 任务执行状态（phase, progress, summary, resolvedFiles）
  │    └ emit: update:open, complete（同步完成且有成功项时触发父刷新）
  │
  └ <SyncFloatingIndicator> 子组件
       ├ props: 无（从 useSyncTask composable 读全局任务状态）
       └ 点击 -> showSyncModal = true（重新打开 Modal）
```

**关键设计**：`useSyncTask` 是一个**全局单例 composable**（不依赖 props），管理当前同步任务的 SSE 连接和进度数据。Modal 和悬浮指示器都从它读数据。这样：
- Modal 关闭时 SSE 不断开，数据持续更新
- 悬浮指示器读同一份数据
- 重新打开 Modal 时数据已就绪，无需恢复

### 4.2 useSyncTask composable（app/composables/useSyncTask.ts）

**职责**：管理一个同步任务的完整生命周期（提交 -> SSE 订阅 -> 进度更新 -> 完成）。**不管理源/目标选择**。

```typescript
// 全局单例状态（模块级变量，跨组件共享）
const taskState = reactive({
  taskId: null as string | null,
  phase: 'idle' as 'idle' | 'scanning' | 'syncing' | 'done',
  scannedCount: 0,
  resolvedFiles: [] as SyncFileInfo[],
  progress: {} as Record<string, CellStatus>,  // key = `${instanceId}::${relativeKey}`
  summary: null as { total: number; success: number; failed: number } | null,
  error: '' as string,
  // 目标实例信息（提交时冻结，用于进度视图渲染）
  targetInstances: [] as { id: string; name: string }[],
})

let eventSource: EventSource | null = null

export function useSyncTask() {
  const isRunning = computed(() => taskState.phase === 'scanning' || taskState.phase === 'syncing')
  const hasTask = computed(() => taskState.taskId !== null)

  /** 提交同步任务 */
  async function submit(request: SyncRequest, targetInstances: { id: string; name: string }[]) {
    // 重置状态
    taskState.taskId = null
    taskState.phase = 'scanning'  // 提交后立即进入 scanning（后端先扫描）
    taskState.scannedCount = 0
    taskState.resolvedFiles = []
    taskState.progress = {}
    taskState.summary = null
    taskState.error = ''
    taskState.targetInstances = targetInstances

    const res = await $fetch<{ taskId: string }>('/api/sync', {
      method: 'POST',
      body: request,
    })
    taskState.taskId = res.taskId
    subscribeSSE(res.taskId)
  }

  function subscribeSSE(tid: string) {
    eventSource = new EventSource(`/api/sync/events?taskId=${tid}`)

    eventSource.addEventListener('scan-progress', (e) => {
      const data = JSON.parse(e.data)
      taskState.scannedCount = data.scannedCount ?? 0
    })

    eventSource.addEventListener('scan-complete', (e) => {
      const data = JSON.parse(e.data)
      taskState.resolvedFiles = data.files ?? []
      // 初始化进度矩阵：所有 instance×file = 'running'
      const next = {}
      for (const inst of taskState.targetInstances) {
        for (const f of taskState.resolvedFiles) {
          next[`${inst.id}::${f.relativeKey}`] = 'running'
        }
      }
      taskState.progress = next
    })

    eventSource.addEventListener('start', () => {
      taskState.phase = 'syncing'
    })

    eventSource.addEventListener('progress', (e) => {
      const data = JSON.parse(e.data)
      if (data.result) {
        taskState.progress[`${data.result.instanceId}::${data.result.fileName}`] = data.result
      }
    })

    eventSource.addEventListener('complete', (e) => {
      const data = JSON.parse(e.data)
      taskState.summary = data.summary
      taskState.phase = 'done'
      // 兜底：未收到 progress 的标记 failed
      for (const [key, val] of Object.entries(taskState.progress)) {
        if (val === 'running') {
          taskState.progress[key] = { status: 'failed', error: '未收到结果', instanceId: '', instanceName: '', fileName: '' }
        }
      }
      eventSource?.close()
      eventSource = null
    })

    eventSource.onerror = () => {
      if (taskState.phase !== 'done') {
        taskState.phase = 'done'
        taskState.error = 'SSE 连接中断'
      }
      eventSource?.close()
      eventSource = null
    }
  }

  /** 关闭/清理任务（不中断后端执行） */
  function clearTask() {
    eventSource?.close()
    eventSource = null
    taskState.taskId = null
    taskState.phase = 'idle'
    taskState.progress = {}
    taskState.summary = null
    taskState.resolvedFiles = []
    taskState.scannedCount = 0
    taskState.error = ''
    taskState.targetInstances = []
  }

  /** 获取实例聚合进度 */
  function getInstanceProgress(instanceId: string) {
    let completed = 0, failed = 0
    for (const f of taskState.resolvedFiles) {
      const cell = taskState.progress[`${instanceId}::${f.relativeKey}`]
      if (cell && cell !== 'running') {
        completed++
        if (typeof cell === 'object' && cell.status === 'failed') failed++
      }
    }
    return { completed, total: taskState.resolvedFiles.length, failed }
  }

  function getCell(instanceId: string, relativeKey: string): CellStatus {
    return taskState.progress[`${instanceId}::${relativeKey}`] ?? null
  }

  return {
    taskState,  // 直接暴露 reactive 对象（.value 不需要，因为是 reactive 不是 ref）
    isRunning,
    hasTask,
    submit,
    clearTask,
    getInstanceProgress,
    getCell,
  }
}
```

**关键设计点**：
1. **`taskState` 用 `reactive` 而非多个 `ref`**：因为它是全局单例，组件直接读 `taskState.xxx` 自动追踪。Modal 和悬浮指示器都从同一个 `taskState` 读数据。
2. **SSE 连接是模块级变量 `eventSource`**：不在 `taskState` 中（不需要响应式），关闭 Modal 不调用 `eventSource.close()`。
3. **`targetInstances` 在提交时冻结**：只存 `{id, name}`，不存完整 MinioInstance（脱敏），用于进度视图渲染实例行。
4. **`submit` 接收完整的 `SyncRequest`**：调用方负责构造请求体（源上下文来自 browser 页 props，目标选择来自 Modal 内部状态）。

### 4.3 SyncModal.vue

**Props**（来自 browser 页，只读）：

```typescript
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
  'update:open': [boolean]
  complete: []  // 同步完成且有成功项时触发父刷新
}>()
```

**内部状态**（仅目标选择，不依赖外部 composable）：

```typescript
// 目标选择（仅 select 阶段使用）
const targetInstanceIds = ref<Set<string>>(new Set())
const targetBuckets = ref<Record<string, string>>({})
const targetBucketOptions = ref<Record<string, BucketLoadState>>({})
const targetPrefix = ref('')
const expanded = ref<Record<string, boolean>>({})
const submitting = ref(false)

// 从 useSyncTask 获取任务状态（全局单例）
const { taskState, isRunning, submit, getInstanceProgress, getCell } = useSyncTask()
```

**Phase 切换逻辑**：

```typescript
// Modal 的阶段由 taskState.phase 决定，不单独维护
// taskState.phase = 'idle' -> 显示目标选择
// taskState.phase = 'scanning' | 'syncing' | 'done' -> 显示进度
const showProgress = computed(() => taskState.phase !== 'idle')
```

**提交逻辑**：

```typescript
async function onSubmit() {
  submitting.value = true
  try {
    const targetInstances = []  // 从 groups + targetInstanceIds 构建 [{id, name}]
    await submit({
      source: {
        instanceId: props.sourceInstanceId,
        bucket: props.sourceBucket,
        prefix: props.sourcePrefix,
        keys: [...props.selectedKeys],
        prefixes: [...props.selectedPrefixes],
      },
      targets: {
        instanceIds: [...targetInstanceIds.value],
        instanceBuckets: { ...targetBuckets.value },
        prefix: targetPrefix.value,
      },
    }, targetInstances)
    // submit 成功后 taskState.phase 自动变为 'scanning'，Modal 切换到进度视图
  } catch (e) {
    toast.add({ title: '提交同步失败', description: e?.data?.statusMessage || e?.message, color: 'error' })
  } finally {
    submitting.value = false
  }
}
```

**关闭逻辑（关键！）**：

```typescript
function onClose() {
  if (isRunning.value) {
    // 进行中：关闭 Modal 但不中断 SSE（后台继续）
    // 悬浮指示器会自动显示（因为它读同一个 taskState）
    toast.add({ title: '同步任务在后台继续', description: '可点击右下角指示器查看进度', color: 'info' })
  } else {
    // 已完成：清理任务状态 + 通知父组件刷新
    if (taskState.summary && taskState.summary.success > 0) {
      emit('complete')  // 父组件 loadObjects()
    }
    clearTask()  // 清理 taskState -> phase 回到 'idle'，悬浮指示器消失
  }
  emit('update:open', false)
}
```

**⚠️ 注意**：关闭 Modal 时**不调用 `clearTask()`**（如果任务还在跑），**不关闭 EventSource**。`taskState` 保持更新，悬浮指示器读同一份数据。只有在已完成状态下关闭时才 `clearTask()`。

**重试逻辑**：

```typescript
async function retryInstance(instanceId: string) {
  // 收窄为该实例的失败文件，重新提交
  const failedFiles = taskState.resolvedFiles.filter(f => {
    const cell = getCell(instanceId, f.relativeKey)
    return cell && typeof cell === 'object' && cell.status === 'failed'
  })
  if (!failedFiles.length) return

  // 重置进度矩阵中该实例的失败项为 running
  for (const f of failedFiles) {
    taskState.progress[`${instanceId}::${f.relativeKey}`] = 'running'
  }

  // 提交新任务（source 不变，targets 收窄）
  await submit({
    source: {
      instanceId: props.sourceInstanceId,
      bucket: props.sourceBucket,
      prefix: props.sourcePrefix,
      keys: failedFiles.map(f => f.key),  // 用完整 key，不是 relativeKey
      prefixes: [],
    },
    targets: {
      instanceIds: [instanceId],
      instanceBuckets: { [instanceId]: targetBuckets.value[instanceId] },
      prefix: targetPrefix.value,
    },
  }, [{ id: instanceId, name: taskState.targetInstances.find(i => i.id === instanceId)?.name ?? '' }])
}
```

**Modal 重新打开时的行为**：

```typescript
// Modal 的 open 由父组件控制（showSyncModal）
// 重新打开时，如果 taskState.phase 不是 'idle'，直接显示进度视图
// 不需要重置目标选择状态（那些只在 phase='idle' 时使用）
watch(() => props.open, (val) => {
  if (val && taskState.phase === 'idle') {
    // 新任务：重置目标选择
    targetInstanceIds.value = new Set()
    targetBuckets.value = {}
    targetBucketOptions.value = {}
    targetPrefix.value = ''
  }
  // 如果 taskState.phase !== 'idle'，说明有进行中/已完成的任务，直接显示进度
})
```

**模板结构**：

```vue
<NuxtModal :open="props.open" :dismissible="false" :ui="{ content: 'max-w-2xl' }"
           @update:open="(v) => emit('update:open', v)">
  <template #header>
    <span class="font-semibold text-highlighted">
      {{ showProgress ? '同步进度' : '同步到其他实例' }}
    </span>
  </template>

  <template #body>
    <!-- 源上下文（始终显示，只读） -->
    <div class="rounded-md bg-elevated px-3 py-2 text-sm"> ... </div>

    <!-- 阶段一：目标选择（phase='idle'） -->
    <div v-if="!showProgress" class="flex flex-col gap-3">
      <!-- 实例树 + bucket + 前缀（复用 dispatch 页模式） -->
    </div>

    <!-- 阶段二：同步进度（phase='scanning'/'syncing'/'done'） -->
    <div v-else class="flex flex-col gap-3">
      <!-- 扫描中 -->
      <div v-if="taskState.phase === 'scanning'" class="...">
        <NuxtIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
        <span>正在扫描源对象... 已发现 {{ taskState.scannedCount }} 个</span>
      </div>

      <!-- 同步进度（复用 BrowserUploadModal 的进度列表模式） -->
      <template v-else>
        <!-- 汇总 + 进度条 -->
        <!-- 实例级折叠列表（每行：实例名 + completed/total + 进度条 + 失败 badge + 重试） -->
        <!-- 展开后文件级状态（fileIcon + relativeKey + 状态图标 + tooltip） -->
      </template>
    </div>
  </template>

  <template #footer>
    <div class="flex w-full justify-end gap-2">
      <!-- idle 阶段：取消 + 开始同步 -->
      <template v-if="!showProgress">
        <NuxtButton color="neutral" variant="ghost" label="取消" @click="emit('update:open', false)" />
        <NuxtButton color="primary" icon="i-lucide-refresh-cw" label="开始同步"
          :disabled="!canSubmit" :loading="submitting" @click="onSubmit" />
      </template>
      <!-- scanning/syncing 阶段：后台继续 + 关闭(禁用) -->
      <template v-else-if="isRunning">
        <NuxtButton color="neutral" variant="ghost" label="关闭" :disabled="true" />
        <NuxtButton color="primary" variant="outline" icon="i-lucide-minus" label="后台继续" @click="onClose" />
      </template>
      <!-- done 阶段：关闭 -->
      <template v-else>
        <NuxtButton color="primary" label="关闭" @click="onClose" />
      </template>
    </div>
  </template>
</NuxtModal>
```

**⚠️ 重要差异（与 BrowserUploadModal 对比）**：
- BrowserUploadModal 关闭时 `eventSource?.close()` + 重置 items。SyncModal 关闭时**不关闭 EventSource、不清理 taskState**（进行中状态下）。
- BrowserUploadModal 的 `watch(open)` 总是重置状态。SyncModal 只在 `phase='idle'` 时重置目标选择。

### 4.4 SyncFloatingIndicator.vue

```typescript
// 从全局单例读状态
const { taskState, isRunning, getInstanceProgress, clearTask } = useSyncTask()

// 悬浮指示器可见条件：有任务且 Modal 未打开
// Modal 的 open 状态需要从父组件传入或用另一个全局状态
// 方案：用 provide/inject 或直接在 browser 页控制显示
const props = defineProps<{
  visible: boolean  // 由父组件控制：taskState.hasTask && !showSyncModal
}>()

const emit = defineEmits<{
  click: []  // 点击指示器 -> 重新打开 Modal
}>()
```

**模板**：

```vue
<!-- 固定在右下角，仅在 visible 时显示 -->
<div v-if="visible"
     class="fixed bottom-4 right-4 z-50 cursor-pointer rounded-lg border border-default bg-default shadow-lg p-3 min-w-48 transition-all hover:shadow-xl"
     @click="emit('click')">
  <!-- 扫描中 -->
  <div v-if="taskState.phase === 'scanning'" class="flex items-center gap-2 text-sm">
    <NuxtIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
    <span class="text-muted">扫描中... {{ taskState.scannedCount }} 个</span>
  </div>

  <!-- 同步中 -->
  <div v-else-if="isRunning" class="flex flex-col gap-1">
    <div class="flex items-center gap-2 text-sm">
      <NuxtIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
      <span>同步中 {{ totalCompleted }}/{{ totalAll }}</span>
    </div>
    <div class="h-1.5 rounded-full bg-elevated overflow-hidden">
      <div class="h-full bg-primary transition-all" :style="{ width: `${progressPercent}%` }" />
    </div>
  </div>

  <!-- 全部成功（自动消失由父组件控制 v-if + setTimeout） -->
  <div v-else-if="taskState.summary && taskState.summary.failed === 0" class="flex items-center gap-2 text-sm text-success">
    <NuxtIcon name="i-lucide-check-circle" class="size-4" />
    <span>同步完成 {{ taskState.summary.success }}/{{ taskState.summary.total }}</span>
  </div>

  <!-- 有失败（常驻，需手动关闭） -->
  <div v-else-if="taskState.summary && taskState.summary.failed > 0" class="flex items-center justify-between gap-2 text-sm">
    <div class="flex items-center gap-2 text-warning">
      <NuxtIcon name="i-lucide-triangle-alert" class="size-4" />
      <span>完成 {{ taskState.summary.success }}/{{ taskState.summary.total }}，{{ taskState.summary.failed }} 失败</span>
    </div>
    <button class="text-muted hover:text-error shrink-0" @click.stop="clearTask()">
      <NuxtIcon name="i-lucide-x" class="size-3.5" />
    </button>
  </div>
</div>
```

**计算属性**：

```typescript
const totalAll = computed(() => taskState.resolvedFiles.length * taskState.targetInstances.length)
const totalCompleted = computed(() => {
  let count = 0
  for (const inst of taskState.targetInstances) {
    count += getInstanceProgress(inst.id).completed
  }
  return count
})
const progressPercent = computed(() => totalAll.value ? (totalCompleted.value / totalAll.value * 100) : 0)
```

### 4.5 browser/index.vue 改动

```typescript
// 新增状态
const showSyncModal = ref(false)

// 引入 useSyncTask（获取 hasTask 判断悬浮指示器是否显示）
const { taskState, hasTask } = useSyncTask()

// 悬浮指示器可见条件
const showFloatingIndicator = computed(() => hasTask.value && !showSyncModal.value)

// 全部成功时 3 秒后自动消失
watch(() => taskState.phase, (phase) => {
  if (phase === 'done' && taskState.summary?.failed === 0 && !showSyncModal.value) {
    setTimeout(() => {
      // 只有用户没有重新打开 Modal 时才清理
      if (!showSyncModal.value) clearTask()
    }, 3000)
  }
})
```

```vue
<!-- 工具栏新增（上传按钮之后，下载选中之前） -->
<NuxtButton
  v-if="selectedCount > 0"
  size="sm"
  color="primary"
  variant="outline"
  icon="i-lucide-refresh-cw"
  label="同步到..."
  @click="showSyncModal = true"
/>

<!-- 同步 Modal -->
<SyncModal
  v-model:open="showSyncModal"
  :source-instance-id="selectedInstanceId"
  :source-instance-name="selectedInstance?.name ?? ''"
  :source-endpoint="selectedInstance?.endpoint ?? ''"
  :source-bucket="selectedBucket"
  :source-prefix="currentPrefix"
  :selected-keys="selectedKeys"
  :selected-prefixes="selectedPrefixes"
  @complete="loadObjects()"
/>

<!-- 悬浮进度指示器 -->
<SyncFloatingIndicator
  :visible="showFloatingIndicator"
  @click="showSyncModal = true"
/>
```

**⚠️ 校验**：「同步到...」按钮在已有同步任务进行中时应禁用（避免多任务并行）：

```typescript
:disabled="hasTask && taskState.phase !== 'done'"
```

或直接不显示（`v-if="selectedCount > 0 && (!hasTask || taskState.phase === 'done')"`）。但这样用户无法在旧任务完成后发起新同步。更好的做法：已完成时允许新同步（点击后先 `clearTask` 再打开 Modal）。

---

## 五、实施步骤

### 步骤 1：后端类型定义
**文件**：`server/types/index.ts`
追加 7 个 sync 类型（SyncSource/SyncTarget/SyncRequest/SyncFileInfo/SyncResult/SyncTask/SyncEvent）。

### 步骤 2：minio.ts 流式上传改造
**文件**：`server/utils/minio.ts`
1. 提取 `initiateMultipartUpload`/`uploadPartFromBuffer`/`completeMultipartUpload` 为独立函数（从 `uploadLarge` L515-595 提取）
2. 重构 `uploadLarge` 调用提取的函数
3. 新增 `uploadFromStream`/`uploadSmallFromStream`/`uploadLargeFromStream`/`streamToParts`/`headObject`

**验证点**：typecheck 无 minio.ts 新增错误。现有 dispatch 的大文件上传不受影响（纯重构）。

### 步骤 3：sync.ts 任务框架
**文件**：`server/utils/sync.ts`（新建）
克隆 dispatcher.ts 框架，实现两阶段执行（扫描+同步）。

**验证点**：typecheck 无 sync.ts 错误。

### 步骤 4：API 路由
**文件**：`server/api/sync/index.post.ts` + `server/api/sync/events.get.ts`（新建）

**验证点**：typecheck 无 api/sync 错误。

### 步骤 5：useSyncTask composable
**文件**：`app/composables/useSyncTask.ts`（新建）
全局单例状态管理 + SSE 订阅。

**验证点**：typecheck 无 useSyncTask 错误。

### 步骤 6：SyncModal 组件
**文件**：`app/components/SyncModal.vue`（新建）
目标选择 + 进度展示两阶段。**关键：关闭 Modal 时不关闭 EventSource、不清理 taskState（进行中状态下）。**

**验证点**：typecheck 无 SyncModal 错误。

### 步骤 7：SyncFloatingIndicator 组件
**文件**：`app/components/SyncFloatingIndicator.vue`（新建）
右下角悬浮指示器，读 useSyncTask 的全局状态。

**验证点**：typecheck 无 SyncFloatingIndicator 错误。

### 步骤 8：browser 页改动
**文件**：`app/pages/ops/browser/index.vue`（修改）
1. 工具栏新增「同步到...」按钮
2. 引入 SyncModal + SyncFloatingIndicator
3. 新增 showSyncModal ref + showFloatingIndicator computed + 全部成功自动消失逻辑

**验证点**：typecheck 无新增错误（browser 页有 5 个预存错误，不是本次引入的）。

### 步骤 9：构建验证
`npm run build` 通过。

### 步骤 10：手动测试
启动 dev server + 至少 2 个 MinIO 实例，验证：

1. **基本流程**：browser 浏览 -> 勾选对象 -> 同步到... -> Modal 选目标 -> 开始同步 -> 扫描 -> 进度 -> 完成 -> 关闭 -> 列表刷新
2. **后台继续**：同步进行中点「后台继续」-> Modal 关闭 -> 右下角悬浮指示器显示 -> 点击指示器 -> Modal 重新打开显示当前进度
3. **大文件**：>8MB 文件 -> 流式 multipart -> 完成
4. **文件夹前缀**：勾选文件夹 -> 扫描阶段展开 -> 同步全部子对象
5. **源实例作目标**：实例树中源实例禁用 + "源" badge
6. **失败重试**：某文件失败 -> 点重试 -> 仅重试失败项
7. **全部成功自动消失**：完成后关闭 Modal -> 指示器显示成功 -> 3 秒后自动消失
8. **有失败常驻**：完成后有失败 -> 指示器常驻 -> 点击可重新打开 Modal -> 手动关闭指示器
9. **源对象不存在**：GetObject 404 -> 标记失败
10. **对象超限**：超 10000 -> 扫描失败 -> Modal 显示错误

---

## 六、风险与注意事项

| 风险 | 应对 |
|---|---|
| **关闭 Modal 时 SSE 被意外断开** | SyncModal 的 onClose 在进行中状态下不调 `eventSource.close()`、不调 `clearTask()`。只有已完成时关闭才清理。**这是上次失败的核心教训。** |
| **Modal 重新打开时状态错乱** | `watch(open)` 只在 `phase='idle'` 时重置目标选择。如果 `phase!='idle'`，直接显示进度视图（数据已在 taskState 中）。 |
| **全局单例状态被多个组件实例共享** | `useSyncTask` 用模块级 `reactive` + 模块级 `eventSource`，所有组件读写同一份。Nuxt 的 composable 默认是函数级作用域，模块级变量在 SSR 下可能有跨请求污染问题，但本项目是 CSR 模式（browser 页客户端渲染），无此问题。 |
| **全部成功自动消失的时序** | `watch(phase)` 检测到 `done + failed=0 + Modal未打开` -> setTimeout 3s -> 再检查 Modal 仍未打开才 `clearTask`。如果用户在 3s 内重新打开了 Modal，不清理。 |
| **同时发起多个同步** | 「同步到...」按钮在 `hasTask && phase!=='done'` 时禁用。已完成时允许新同步（先 `clearTask` 再打开 Modal）。 |
| **流式分片精度** | `streamToParts` 用 Buffer 累积确保每片精确 partSize。详见 `P0_IMPL_03_SYNC.md` 3.2.4。 |
| **multipart 函数提取影响现有分发** | 提取是纯重构，`uploadLarge` 行为不变。需回归测试现有 dispatch 的大文件上传。 |
| **fetch body 流式兼容性** | Node 18+ undici fetch 支持 Web ReadableStream 作为 body。`uploadPartFromBuffer` 的 chunk 用 `Uint8Array` + `as BodyInit`。 |
| **大文件 GetObject 超时** | `getObjectStream` 10 分钟超时。大文件用整文件流式传输。如果超时是问题，后续可改为 Range 请求逐片拉取（见 `P0_IMPL_03_SYNC.md` 5.1）。本次先用整文件流式，测试观察。 |
| **目标 key 路径遍历** | `sanitizeObjectKey(targetPrefix + relativeKey)` 复用现有清洗函数。 |

---

## 七、与前次实现的关键差异对照

| 维度 | 前次实现（失败） | 本次实现 |
|---|---|---|
| 状态管理 | `useSync` 把源/目标/进度全放 composable | `useSyncTask` 只管任务执行，目标选择在 Modal 内部，源上下文从 props 传入 |
| 入口跳转 | Modal 提交后 `navigateTo('/ops/sync?taskId=xxx')` | 不跳转，Modal 内展示进度 |
| 状态恢复 | `attachTask` 逆向重建源/目标状态，与 watchers 冲突 | 不需要恢复，SSE 不断开，taskState 持续更新 |
| SSE 生命周期 | 关闭 Modal 时关闭 EventSource | 进行中关闭 Modal 不关闭 EventSource |
| 任务详情 API | 需要 `GET /api/sync/:id` | 不需要，taskState 内存中已有全部数据 |
| 进度可见性 | 跳转后靠独立页面展示 | Modal + 悬浮指示器读同一份 taskState |
| composable 定位 | 重量级（源+目标+进度+attach+reset） | 轻量级（仅任务执行+进度），不碰 UI 选择状态 |
