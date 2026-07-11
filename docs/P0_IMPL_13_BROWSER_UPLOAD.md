# 提议 13 实施计划：对象浏览器上传文件

> **目标**：在对象浏览器（`/ops/browser`）中支持上传文件/文件夹到当前实例的当前 bucket/前缀下。
>
> 配套交互设计文档：`P0_DESIGN_13_BROWSER_UPLOAD.md`

---

## 一、现状分析

### 1.1 核心结论：后端零改动

对象浏览器上传 = dispatch 的单实例特例。`DispatchRequest` 已有的三个字段完全覆盖需求：

| 字段 | 对象浏览器传值 | 分发页传值 |
|---|---|---|
| `instanceIds` | `[当前实例ID]` | 用户勾选的多个实例 |
| `bucket` | 当前浏览的 bucket | 不用（用 `instanceBuckets`） |
| `prefix` | 当前浏览前缀 | 用户输入的前缀 |
| `groupIds` | `[]` | 用户勾选的组 |
| `instanceBuckets` | 不传（用全局 `bucket`） | 按实例指定 |

dispatcher.ts L163-165 会把 `prefix` 拼到 `objectKey` 前面：`prefix/objectKey`，正是"上传到当前浏览目录下"的语义。

### 1.2 现有可复用能力

```
后端（零改动）：
  server/api/uploads/index.post.ts      ← multipart 暂存，返回 StoredFile
  server/api/uploads/[id].delete.ts     ← 删除暂存文件
  server/api/dispatch/index.post.ts     ← 提交分发任务，支持单实例 + bucket + prefix
  server/api/dispatch/events.get.ts     ← SSE 进度推送
  server/utils/dispatcher.ts            ← uploadObject（小文件 PUT + 大文件 multipart）
  server/utils/uploads.ts               ← storeUpload / cleanupExpired（TTL 清理）
  server/types/index.ts                 ← DispatchRequest 已有 prefix 字段

前端（部分复用）：
  app/composables/useDispatch.ts
    ├ uploadFile(file, objectKey?)      ← 暂存单个文件，可直接复用
    ├ addFiles(fileList)                ← 多文件选择，可直接复用
    ├ addFolder(fileList)               ← 文件夹选择（webkitdirectory），可直接复用
    ├ removeUpload(id)                  ← 移除暂存文件，可直接复用
    └ submit()                          ← 分发提交 + SSE 订阅，逻辑可参照但需收窄参数

  app/pages/ops/dispatch/index.vue
    ├ onFilesSelected / onFolderSelected ← 选文件 input 模式
    ├ fileGroups computed                ← 单文件/文件夹聚合分组，可参照
    └ formatSize / fileIcon              ← 工具函数，可复用或提取

  app/pages/ops/browser/index.vue
    ├ 工具栏（L844）                     ← 新增"上传"按钮的挂载点
    ├ loadObjects()                      ← 上传完成后刷新列表
    └ selectedInstanceId / selectedBucket / currentPrefix ← 目标上下文来源
```

### 1.3 缺失能力

- 1 个前端组件：`app/components/BrowserUploadModal.vue`（上传对话框）
- `app/pages/ops/browser/index.vue`：工具栏新增"上传"按钮 + 对话框状态管理

**后端零新增路由、零新增类型、零新增工具函数。**

---

## 二、改动清单

### 2.1 后端

| 文件 | 操作 | 说明 |
|---|---|---|
| 无 | — | 后端完全复用现有 dispatch + uploads 基建 |

### 2.2 前端

| 文件 | 操作 | 说明 |
|---|---|---|
| `app/components/BrowserUploadModal.vue` | 新建 | 上传对话框组件：选文件 + 暂存 + dispatch 提交 + SSE 进度 |
| `app/pages/ops/browser/index.vue` | 修改 | 工具栏新增"上传"按钮 + 引入对话框组件 + 完成后刷新列表 |

**总计：后端 0 改 0 新，前端 1 改 1 新。零新增依赖。**

---

## 三、技术设计

### 3.1 组件职责划分

```
app/pages/ops/browser/index.vue（父页面）
  │
  ├ 持有目标上下文：selectedInstanceId, selectedBucket, currentPrefix
  ├ 工具栏新增 [上传] 按钮，点击后 showUploadModal = true
  ├ <BrowserUploadModal> 子组件
  │    ├ props: instanceId, bucket, prefix, instanceName, endpoint
  │    ├ 内部管理：文件列表、暂存状态、dispatch 进度、SSE 订阅
  │    └ emit: close（关闭对话框）, complete（上传完成，触发父刷新）
  └ complete 回调 -> loadObjects() 刷新对象列表
```

**为什么不复用 `useDispatch` composable？**

`useDispatch` 是为多实例场景设计的，绑定了：
- `selectedInstanceIds`（Set 多选）
- `instanceBuckets`（按实例指定 bucket）
- `getInstanceProgress`（实例维度聚合）
- `loadBuckets`（批量加载 bucket 交集）

这些对单实例对话框都是多余的。对话框组件内部自管理状态更清晰，但复用 `useDispatch` 中的核心函数模式（`uploadFile`、SSE 订阅逻辑）-- 直接在组件内实现等价逻辑，代码量不大且更直白。

### 3.2 BrowserUploadModal.vue 状态设计

```typescript
// Props（来自父页面，只读）
const props = defineProps<{
  open: boolean
  instanceId: string
  instanceName: string
  endpoint: string
  bucket: string
  prefix: string           // 当前浏览前缀，如 "config/2025Q3/"
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  complete: []
}>()

// 文件列表与暂存状态
interface UploadItem {
  id: string               // StoredFile.id（暂存后获得）
  name: string
  objectKey: string        // 单文件=文件名，文件夹内=相对路径
  size: number
  contentType: string
  status: 'pending' | 'staging' | 'staged' | 'dispatching' | 'success' | 'failed'
  progress: number         // 暂存阶段 XHR 百分比 0-100
  error?: string
}
const items = ref<UploadItem[]>([])

// 整体阶段
type Phase = 'select' | 'staging' | 'dispatching' | 'done'
const phase = ref<Phase>('select')
const taskId = ref<string | null>(null)
const summary = ref<{ total: number; success: number; failed: number } | null>(null)
let eventSource: EventSource | null = null
```

### 3.3 暂存上传实现

复用 `POST /api/uploads`，但用 XHR 替代 `$fetch` 以获取上传进度：

```typescript
async function stageFile(file: File, objectKey?: string): Promise<StoredFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const form = new FormData()
    form.append('file', file)
    if (objectKey) form.append('objectKey', objectKey)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        // 更新对应 item 的 progress
        item.progress = Math.round((e.loaded / e.total) * 100)
      }
    }
    xhr.onload = () => {
      if (xhr.status === 200) {
        resolve(JSON.parse(xhr.responseText))
      } else {
        reject(new Error(xhr.statusText))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误'))
    xhr.open('POST', '/api/uploads')
    xhr.send(form)
  })
}
```

**与分发页的差异**：分发页用 `$fetch` 无进度百分比，对象浏览器对话框用 XHR 有进度。这是可接受的差异--对话框是即时反馈场景，进度百分比价值更高；分发页文件多，逐文件完成态已足够。

### 3.4 选文件逻辑

直接参照分发页的 `onFilesSelected` / `onFolderSelected`：

```typescript
function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return
  for (const file of Array.from(input.files)) {
    addPendingItem(file, file.name)
  }
  input.value = ''
}

function onFolderSelected(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files) return
  for (const file of Array.from(input.files)) {
    const objectKey = file.webkitRelativePath || file.name
    addPendingItem(file, objectKey)
  }
  input.value = ''
}

function addPendingItem(file: File, objectKey: string) {
  items.value.push({
    id: '',                 // 暂存后填充
    name: file.name,
    objectKey,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
    status: 'pending',
    progress: 0,
  })
}
```

### 3.5 提交流程

```typescript
async function startUpload() {
  // 1. 暂存所有 pending 文件
  phase.value = 'staging'
  for (const item of items.value) {
    if (item.status !== 'pending') continue
    item.status = 'staging'
    try {
      const file = findFileByItem(item)  // 保留 File 引用
      const stored = await stageFile(file, item.objectKey)
      item.id = stored.id
      item.status = 'staged'
    } catch (e: any) {
      item.status = 'failed'
      item.error = e?.message || '暂存失败'
    }
  }

  // 2. 检查是否有成功暂存的文件
  const staged = items.value.filter(i => i.status === 'staged')
  if (!staged.length) {
    phase.value = 'done'
    summary.value = { total: items.value.length, success: 0, failed: items.value.length }
    return
  }

  // 3. 提交 dispatch（单实例 + bucket + prefix）
  phase.value = 'dispatching'
  for (const item of staged) item.status = 'dispatching'

  try {
    const res = await $fetch<{ taskId: string }>('/api/dispatch', {
      method: 'POST',
      body: {
        files: staged.map(i => ({ id: i.id, objectKey: i.objectKey })),
        instanceIds: [props.instanceId],
        groupIds: [],
        bucket: props.bucket,
        prefix: props.prefix || undefined,
      },
    })
    taskId.value = res.taskId
    subscribeSSE(res.taskId)
  } catch (e: any) {
    // dispatch 提交失败，全部标记失败
    for (const item of staged) {
      item.status = 'failed'
      item.error = e?.data?.statusMessage || e?.message || '提交失败'
    }
    phase.value = 'done'
    summary.value = { total: items.value.length, success: 0, failed: staged.length }
  }
}
```

### 3.6 SSE 订阅

```typescript
function subscribeSSE(tid: string) {
  eventSource = new EventSource(`/api/dispatch/events?taskId=${tid}`)

  eventSource.addEventListener('start', () => {
    // 所有 dispatching 状态保持，等待 progress
  })

  eventSource.addEventListener('progress', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    if (data.result) {
      const item = items.value.find(i => i.objectKey === data.result.fileName)
      if (item) {
        item.status = data.result.status  // 'success' | 'failed'
        item.error = data.result.error
      }
    }
  })

  eventSource.addEventListener('complete', (e: MessageEvent) => {
    const data = JSON.parse(e.data)
    summary.value = data.summary
    phase.value = 'done'

    // 兜底：未收到 progress 的 dispatching 项标记失败
    for (const item of items.value) {
      if (item.status === 'dispatching') {
        item.status = 'failed'
        item.error = '未收到结果'
      }
    }

    eventSource?.close()
    eventSource = null

    // 有成功项时通知父组件刷新
    if (data.summary.success > 0) {
      emit('complete')
    }
  })

  eventSource.onerror = () => {
    if (phase.value === 'dispatching') {
      phase.value = 'done'
      for (const item of items.value) {
        if (item.status === 'dispatching') {
          item.status = 'failed'
          item.error = 'SSE 连接中断'
        }
      }
    }
    eventSource?.close()
    eventSource = null
  }
}
```

### 3.7 objectKey 匹配说明

SSE progress 事件中 `result.fileName` = dispatcher 用的 `f.objectKey`（即暂存时的 objectKey，**不含 prefix**）。因此前端用 `item.objectKey === data.result.fileName` 匹配。

注意：如果同批次有相同 objectKey 的文件（去重后只剩一个），匹配不会出问题。

### 3.8 对话框关闭处理

```typescript
function onClose() {
  // staging 阶段：XHR 无法可靠取消（已发出的请求），但关闭后不再处理响应
  // dispatching 阶段：后端任务继续跑，不中断
  if (phase.value === 'dispatching') {
    // 提示用户任务在后台继续
    toast.add({
      title: '上传任务在后台继续',
      description: '关闭不会中断，完成后可刷新列表查看',
      color: 'info',
    })
  }
  eventSource?.close()
  eventSource = null
  emit('update:open', false)
}

// 对话框重新打开时重置状态
watch(() => props.open, (val) => {
  if (val) {
    items.value = []
    phase.value = 'select'
    taskId.value = null
    summary.value = null
  }
})
```

### 3.9 文件列表分组展示

参照分发页的 `fileGroups` computed：单文件逐行 + 文件夹聚合。对话框内空间有限，文件夹聚合为一条可展开条目。

```typescript
const fileGroups = computed(() => {
  const folderMap = new Map<string, UploadItem[]>()
  const singles: UploadItem[] = []
  for (const item of items.value) {
    const slashIdx = item.objectKey.indexOf('/')
    if (slashIdx > 0) {
      const folder = item.objectKey.slice(0, slashIdx)
      if (!folderMap.has(folder)) folderMap.set(folder, [])
      folderMap.get(folder)!.push(item)
    } else {
      singles.push(item)
    }
  }
  // 返回 [{ type: 'file', items: [single] }, { type: 'folder', folderName, items }]
  return [...singles.map(i => ({ type: 'file' as const, items: [i] })),
          ...[...folderMap.entries()].map(([folderName, items]) => ({ type: 'folder' as const, folderName, items }))]
})
```

### 3.10 父页面改动

`app/pages/ops/browser/index.vue`：

```vue
<!-- 工具栏新增上传按钮（L855 flex-1 之后） -->
<NuxtButton
  size="sm"
  color="primary"
  variant="outline"
  icon="i-lucide-upload"
  label="上传"
  :disabled="!selectedInstanceId || !selectedBucket"
  @click="showUploadModal = true"
/>

<!-- 对话框 -->
<BrowserUploadModal
  v-model:open="showUploadModal"
  :instance-id="selectedInstanceId"
  :instance-name="inst?.name ?? ''"
  :endpoint="inst?.endpoint ?? ''"
  :bucket="selectedBucket"
  :prefix="currentPrefix"
  @complete="loadObjects()"
/>
```

```typescript
const showUploadModal = ref(false)
// inst, selectedInstanceId, selectedBucket, currentPrefix, loadObjects 均已存在
```

---

## 四、实施步骤

### 步骤 1：新建 BrowserUploadModal.vue 组件

**文件**：`app/components/BrowserUploadModal.vue`

实现内容：
- Props: `open, instanceId, instanceName, endpoint, bucket, prefix`
- Emits: `update:open, complete`
- 内部状态：`items`（文件列表）、`phase`（select/staging/dispatching/done）、`summary`
- 功能：
  - 选文件 / 选文件夹（`<input type="file" multiple>` + `webkitdirectory`）
  - 文件列表分组展示（单文件 + 文件夹聚合）
  - 暂存上传（XHR + onprogress）
  - dispatch 提交（单实例 + bucket + prefix）
  - SSE 订阅（start/progress/complete）
  - 进度展示（文件级状态 + 整体进度条）
  - 完成汇总 + 关闭
- 边界处理：暂存失败标记、SSE 中断兜底、dispatching 阶段关闭提示

### 步骤 2：修改对象浏览器页面

**文件**：`app/pages/ops/browser/index.vue`

改动点：
1. 工具栏（L855 flex-1 之后）新增「上传」按钮
2. 引入 `BrowserUploadModal` 组件，绑定 props 和 `@complete` 回调
3. 新增 `showUploadModal` ref
4. `@complete` 回调调用现有 `loadObjects()` 刷新对象列表

### 步骤 3：手动测试

启动 dev server + 本地 MinIO 容器，验证：
1. 选实例 + bucket + 前缀 -> 点上传 -> 对话框显示目标上下文
2. 添加单文件 -> 暂存 -> dispatch -> 进度 -> 完成 -> 列表刷新
3. 添加文件夹 -> 目录结构保留 -> 暂存 -> dispatch -> 完成
4. 大文件（>8MB）-> multipart 上传 -> 完成
5. 暂存失败 -> 标记错误 -> 其他文件继续
6. dispatch 失败 -> 标记错误 -> 完成汇总
7. dispatching 阶段关闭对话框 -> 提示后台继续
8. 同名对象 -> 覆盖不确认

---

## 五、风险与注意事项

| 风险 | 应对 |
|---|---|
| XHR 上传进度在某些浏览器不准确 | 用 `e.lengthComputable` 守卫，不精确时显示 indeterminate |
| dispatch 任务后台执行时用户关闭对话框 | 提示"后台继续"，不终止任务；重新打开对话框是全新会话 |
| 暂存文件磁盘残留 | 复用现有 cleanup plugin（TTL 清理），无需额外处理 |
| 同批次 objectKey 重复 | 前端列表去重展示（保留最后一个），dispatch 后上传覆盖前上传 |
| SSE 连接中断 | onerror 兜底标记未完成项为失败，显示汇总 |
| 对象浏览器无 selectedBucket 时点上传 | 按钮 disabled + tooltip |

---

## 六、与分发页的代码复用对照

| 能力 | 分发页实现 | 对象浏览器实现 | 复用方式 |
|---|---|---|---|
| 暂存上传 | `useDispatch.uploadFile()` 用 `$fetch` | 组件内 `stageFile()` 用 XHR | 逻辑等价，XHR 换取进度 |
| 选文件 | `onFilesSelected` | 同名函数 | 模式直接参照 |
| 选文件夹 | `onFolderSelected` + `webkitRelativePath` | 同名函数 | 模式直接参照 |
| 文件分组 | `fileGroups` computed | 同名 computed | 模式直接参照 |
| dispatch 提交 | `useDispatch.submit()` 多实例 | 组件内 `startUpload()` 单实例 | 参数收窄 |
| SSE 订阅 | `useDispatch` 内 EventSource | 组件内 `subscribeSSE()` | 事件处理相同 |
| 进度展示 | 实例级聚合折叠 | 文件级扁平列表 | 单实例无需聚合层 |
| 完成回调 | toast + sessionStorage | emit complete + 父刷新列表 | 场景差异 |

**结论**：不机械复用 `useDispatch`（它绑定多实例语义），而是参照其模式在对话框组件内实现单实例版本。代码重复量可控，职责更清晰。
