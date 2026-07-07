# 文件分发能力扩展 · 实施计划

> 关联技术方案：[DISPATCH-V2.md](./DISPATCH-V2.md)
> 本文档基于技术方案拆解为可逐步执行的实施任务。每个任务有明确的产出文件、改动内容、依赖关系和验证手段。
> 原则：**先后端再前端，每步可独立验证，验证通过再进入下一步**。

---

## 任务总览

| # | 任务 | 性质 | 依赖 | 产出物 |
|---|---|---|---|---|
| 1 | MinIO 上传函数升级 | 后端 | 无 | `server/utils/minio.ts` 扩展 |
| 2 | 暂存管理 + 上传 API | 后端 | 无 | `server/utils/uploads.ts` + 2 个 API + plugin |
| 3 | dispatcher + dispatch API 适配 | 后端 | 1, 2 | `server/types/index.ts` + `dispatcher.ts` + `dispatch/index.post.ts` |
| 4 | 前端改造 | 前端 | 3 | `useDispatch.ts` + `dispatch/index.vue` |
| 5 | 收尾：文档 + 构建验证 | 全局 | 1-4 | DEPLOY/DESIGN/TECH 更新 + build 通过 |

依赖关系图：

```
任务1 (上传函数) ──┐
                  ├──► 任务3 (打通链路) ──► 任务4 (前端) ──► 任务5 (收尾)
任务2 (暂存+API) ──┘
```

任务 1 和任务 2 互相独立，可并行推进。

---

## 任务 1：MinIO 上传函数升级

**目标**：让后端能对真实 MinIO 实例上传任意类型、任意大小的磁盘文件。

**改动文件**：

| 文件 | 改动 |
|---|---|
| `server/utils/minio.ts` | 新增 `uploadObject`、`uploadSmall`、`uploadLarge`、`abortMultipartUpload`、`inferContentType`、`sanitizeObjectKey`、`extractXmlTag`、`sha256Hex`；新增常量 `EMPTY_SHA256`、`UNSIGNED_PAYLOAD`、`MULTIPART_THRESHOLD`、`PART_SIZE`。**保留** `presignPutUrl`、`signRequest`、`uploadJson`（保留供向后兼容/回退）、`listBuckets`、`testConnectivity` |

**具体改动点**：

### 1.1 常量与辅助函数（新增到 `minio.ts` 顶部）

```ts
const MULTIPART_THRESHOLD = Number(process.env.MULTIPART_THRESHOLD) || 8 * 1024 * 1024
const PART_SIZE = Number(process.env.MULTIPART_PART_SIZE) || 5 * 1024 * 1024
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

function sha256Hex(data: string): string
function extractXmlTag(xml: string, tag: string): string | null
export function inferContentType(filename: string): string
export function sanitizeObjectKey(key: string): string
```

`inferContentType` 的 MIME 表见技术方案 §4.5。

### 1.2 `uploadObject`（统一入口，导出）

```ts
export async function uploadObject(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  localPath: string,
  contentType: string,
): Promise<void> {
  const size = Bun.file(localPath).size
  if (size < MULTIPART_THRESHOLD) {
    await uploadSmall(instance, bucket, objectKey, localPath, contentType)
  } else {
    await uploadLarge(instance, bucket, objectKey, localPath, contentType)
  }
}
```

### 1.3 `uploadSmall`（内部函数）

复用现有 `presignPutUrl`，body 从字符串改为 `Bun.file(localPath).arrayBuffer()`。精确指定 `Content-Type` header。实现见技术方案 §4.2。

### 1.4 `uploadLarge`（内部函数）

手写 S3 Multipart Upload 三步：Initiate → UploadPart ×N → Complete。全部用现有 `signRequest()` 签名。失败时调 `abortMultipartUpload` 清理。实现见技术方案 §4.3。

### 1.5 `abortMultipartUpload`（内部函数）

`DELETE /{bucket}/{key}?uploadId=X`，用 `signRequest` 签名。

**验证**：

新建临时路由 `server/api/_test-upload.post.ts`（实施完成后删除）：

```ts
// 用法：POST /api/_test-upload?endpoint=...&bucket=...&key=...&file=<本地路径>
// 或用固定测试实例，走 readBody 传 { endpoint, accessKey, secretKey, bucket, key, localPath }
```

测试三种场景：
1. **小 JSON 文件**（< 8MB）→ MinIO Console 查看文件，Content-Type 为 `application/json`，可预览
2. **小二进制文件**（图片 < 8MB）→ Content-Type 正确，下载后与原文件二进制一致
3. **大文件**（> 8MB）→ 确认走 multipart（日志可见三步），下载后 size 一致

```bash
# 生成测试大文件（PowerShell）
fsutil file createnew test-large.bin 10485760   # 10MB

# 或用 Bun
bun -e "Bun.write('test-large.bin', new Uint8Array(10*1024*1024))"
```

验证通过后**删除** `_test-upload.post.ts` 和测试大文件。

**完成标志**：三个场景全部通过，`uploadObject` 对外可用，临时测试路由已清理。

---

## 任务 2：暂存管理 + 上传 API

**目标**：浏览器能通过 HTTP 上传文件到控制中心磁盘暂存，并获得 `fileId`。

**改动文件**：

| 文件 | 改动 |
|---|---|
| `server/types/index.ts` | 新增 `StoredFile` interface |
| **新增** `server/utils/uploads.ts` | 暂存目录管理、内存 Map、`storeUpload`/`getStoredFile`/`deleteStoredFile`/`cleanupExpired` |
| **新增** `server/api/uploads/index.post.ts` | `POST /api/uploads` multipart 上传 |
| **新增** `server/api/uploads/[id].delete.ts` | `DELETE /api/uploads/:id` 删除暂存 |
| **新增** `server/plugins/cleanup.ts` | Nitro plugin：启动时 + 每 6h 清理孤儿 |
| `.gitignore` | 新增 `server/data/uploads/` |

**具体改动点**：

### 2.1 `StoredFile` 类型（`server/types/index.ts` 添加）

```ts
export interface StoredFile {
  id: string
  name: string
  objectKey: string
  size: number
  contentType: string
  storedPath: string
  uploadedAt: string
}
```

### 2.2 `server/utils/uploads.ts`

```ts
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? resolve(process.cwd(), 'server/data/uploads')
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 0
const UPLOAD_TTL_HOURS = Number(process.env.UPLOAD_TTL_HOURS) || 24

const fileRegistry = new Map<string, StoredFile>()

export async function storeUpload(rawName: string, data: Buffer): Promise<StoredFile>
export function getStoredFile(id: string): StoredFile | null
export async function deleteStoredFile(id: string): Promise<void>
export async function cleanupExpired(): Promise<number>
```

- `storeUpload`：生成 `uf-<uuid>` id，sanitize 文件名，落盘到 `UPLOAD_DIR/<id>/<safeName>`，元数据写入内存 Map
- `deleteStoredFile`：删磁盘文件 + 删 Map 记录（容错：元数据不在也尝试删目录）
- `cleanupExpired`：扫描 `UPLOAD_DIR` 子目录，按 `uploadedAt`（从内存 Map 查；Map 没有的按目录创建时间）超过 TTL 的删除

### 2.3 `POST /api/uploads`

```ts
// server/api/uploads/index.post.ts
export default defineEventHandler(async (event) => {
  const form = await readMultipartFormData(event)
  const part = form?.find(p => p.name === 'file')
  if (!part) throw createError({ statusCode: 400, statusMessage: '缺少 file 字段' })

  const name = part.filename ?? 'unnamed'
  if (MAX_UPLOAD_SIZE > 0 && part.data.length > MAX_UPLOAD_SIZE) {
    throw createError({ statusCode: 413, statusMessage: '文件超出大小限制' })
  }

  const stored = await storeUpload(name, part.data)
  setResponseStatus(event, 201)
  return stored
})
```

### 2.4 `DELETE /api/uploads/:id`

```ts
// server/api/uploads/[id].delete.ts
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const stored = getStoredFile(id)
  if (!stored) throw createError({ statusCode: 404, statusMessage: '文件不存在' })
  await deleteStoredFile(id)
  setResponseStatus(event, 204)
})
```

### 2.5 cleanup plugin

```ts
// server/plugins/cleanup.ts
export default defineNitroPlugin(() => {
  cleanupExpired().catch(() => {})
  setInterval(() => cleanupExpired().catch(() => {}), 6 * 60 * 60 * 1000)
})
```

**验证**：

```bash
# 启动 dev server 后

# 上传单个文件
curl -F "file=@docs/DESIGN.md" http://localhost:3000/api/uploads
# 期望响应：{ "id":"uf-xxx", "name":"DESIGN.md", "objectKey":"DESIGN.md", "size":..., "contentType":"text/markdown", "storedPath":"uf-xxx/DESIGN.md", "uploadedAt":"..." }

# 检查磁盘文件存在
ls server/data/uploads/uf-xxx/

# 删除暂存文件
curl -X DELETE http://localhost:3000/api/uploads/uf-xxx
# 期望：HTTP 204，磁盘文件已删

# 上传 JSON 文件
curl -F "file=@server/data/groups.json" http://localhost:3000/api/uploads
```

**完成标志**：上传返回正确 `StoredFile`，磁盘文件存在，删除后磁盘文件清除，`.gitignore` 生效。

---

## 任务 3：dispatcher + dispatch API 适配

**目标**：后端整条链路打通——`POST /dispatch` 接收 `fileId` 列表，从磁盘读取文件，分发到各 MinIO 实例，SSE 推送进度。

**依赖**：任务 1（`uploadObject`）+ 任务 2（`getStoredFile`）

**改动文件**：

| 文件 | 改动 |
|---|---|
| `server/types/index.ts` | `DispatchRequest.files` 改型为 `{ id: string; objectKey?: string }[]`；新增 `prefix?: string`；`DispatchTask` 加 `resolvedFiles: StoredFile[]` |
| `server/api/dispatch/index.post.ts` | 解析 `files[].id` → 查 `getStoredFile` → 组装 `resolvedFiles`；透传 `prefix` |
| `server/utils/dispatcher.ts` | `processInstance` 改为从磁盘上传（调 `uploadObject`）；`executeDispatch` 透传 `prefix`；`processInstance` 签名加 `files: StoredFile[]` 和 `prefix` 参数 |

**具体改动点**：

### 3.1 类型变更

```ts
// DispatchRequest
export interface DispatchRequest {
  files: { id: string; objectKey?: string }[]   // ← 改型
  groupIds: string[]
  instanceIds: string[]
  bucket?: string
  instanceBuckets?: Record<string, string>
  prefix?: string                               // ← 新增
}

// DispatchTask
export interface DispatchTask {
  id: string
  request: DispatchRequest
  status: 'pending' | 'running' | 'done'
  resolvedInstances: MinioInstance[]
  resolvedFiles: StoredFile[]                   // ← 新增
  results: DispatchResult[]
  createdAt: string
  finishedAt?: string
}
```

### 3.2 `dispatch/index.post.ts`

```ts
// 解析 fileId → StoredFile
const resolvedFiles: StoredFile[] = []
for (const f of body.files) {
  const stored = getStoredFile(f.id)
  if (!stored) throw createError({ statusCode: 400, statusMessage: `文件 ${f.id} 不存在或已过期` })
  resolvedFiles.push(f.objectKey ? { ...stored, objectKey: sanitizeObjectKey(f.objectKey) } : stored)
}
// task.resolvedFiles = resolvedFiles
// executeDispatch(task).catch(...) 不变
```

### 3.3 `dispatcher.ts`

`processInstance` 签名改为：

```ts
async function processInstance(
  taskId: string,
  instance: MinioInstance,
  files: StoredFile[],          // ← 新增
  bucketOverride: string | undefined,
  instanceBuckets?: Record<string, string>,
  prefix?: string,              // ← 新增
): Promise<void>
```

循环内：
```ts
const objectKey = prefix
  ? `${prefix.replace(/\/+$/, '')}/${f.objectKey}`
  : f.objectKey
const localPath = resolve(UPLOAD_DIR, f.storedPath)
await uploadObject(instance, targetBucket, objectKey, localPath, f.contentType)
```

`executeDispatch` 中调用 `processInstance` 处传入 `task.resolvedFiles` 和 `task.request.prefix`。

**验证**（手动端到端）：

```bash
# 1. 先上传文件拿 fileId
curl -F "file=@docs/DESIGN.md" http://localhost:3000/api/uploads
# 记下返回的 id，假设 "uf-xxx"

# 2. 手动 POST /dispatch（需要有已配置的实例组）
curl -X POST http://localhost:3000/api/dispatch \
  -H "Content-Type: application/json" \
  -d '{"files":[{"id":"uf-xxx"}],"groupIds":["grp-001"],"instanceBuckets":{"<inst-id>":"ndm"},"prefix":"test/"}'
# 期望：202 { "taskId":"task-xxx" }

# 3. 监听 SSE
curl -N http://localhost:3000/api/dispatch/events?taskId=task-xxx
# 期望：收到 start → progress(成功/失败) → complete 事件

# 4. MinIO Console 确认
#    文件出现在 ndm bucket 的 test/ 前缀下，名为 DESIGN.md，Content-Type 正确
```

**完成标志**：手动 curl 上传 → 分发 → SSE 收到进度 → MinIO Console 确认文件就位且路径/前缀/Content-Type 正确。后端整条链路打通，无前端依赖。

---

## 任务 4：前端改造

**目标**：前端支持选择任意类型文件/文件夹、异步上传、聚合进度展示、目标前缀。

**依赖**：任务 3（后端 API 就绪）

**改动文件**：

| 文件 | 改动 |
|---|---|
| `app/composables/useDispatch.ts` | 全面改造：`files` 改为 `StoredFile[]`；新增 `uploadFile`/`removeUpload`/`uploadFolder`；`submit` 改为传 `{ id, objectKey }[]`；新增 `prefix` ref；新增 `getInstanceProgress` 聚合计算 |
| `app/pages/ops/dispatch/index.vue` | 全面改造：两按钮（文件/文件夹）、文件列表树形展示、异步上传状态、MIME 图标、目标前缀输入框、进度聚合视图 |

### 4.1 `useDispatch.ts` 改动点

**数据结构变更**：
```ts
const files = ref<StoredFile[]>([])           // ← 原 { name; content }[]
const prefix = ref('')                         // ← 新增
const uploadStates = ref<Record<string, 'uploading' | 'ready' | 'error'>>({})
```

**新增方法**：
```ts
async function uploadFile(file: File): Promise<StoredFile> {
  const form = new FormData()
  form.append('file', file)
  const stored = await $fetch<StoredFile>('/api/uploads', { method: 'POST', body: form })
  files.value.push(stored)
  return stored
}

async function uploadFolder(fileList: FileList) {
  for (const file of Array.from(fileList)) {
    const objectKey = file.webkitRelativePath
      ? file.webkitRelativePath.replace(/^[^/]+\//, '')
      : file.name
    // 逐个上传，UI 显示进度
    try {
      uploadStates.value[file.name] = 'uploading'
      const stored = await uploadFile(file)
      // 覆盖 objectKey 为相对路径
      stored.objectKey = objectKey
      uploadStates.value[stored.id] = 'ready'
    } catch {
      uploadStates.value[file.name] = 'error'
    }
  }
}

async function removeUpload(id: string) {
  await $fetch(`/api/uploads/${id}`, { method: 'DELETE' })
  files.value = files.value.filter(f => f.id !== id)
}

function getInstanceProgress(instanceId: string): { completed: number; total: number; failed: number } {
  let completed = 0, failed = 0
  for (const f of files.value) {
    const cell = progress.value[cellKey(instanceId, f.objectKey)]
    if (cell && cell !== 'running') {
      completed++
      if (cell.status === 'failed') failed++
    }
  }
  return { completed, total: files.value.length, failed }
}
```

**`submit` 改动**：
```ts
const body = {
  files: files.value.map(f => ({ id: f.id, objectKey: f.objectKey })),
  groupIds,
  instanceIds,
  instanceBuckets: buckets,
  prefix: prefix.value || undefined,    // ← 新增
}
```

**SSE 监听**：`progress` 事件用 `data.result.instanceId + data.result.fileName` 作为 cellKey，逻辑不变。

### 4.2 `dispatch/index.vue` 改动点

**文件选择区**（替换原 `onFilesSelected`）：
```html
<label class="cursor-pointer">
  <input type="file" multiple class="hidden" @change="onFilesSelected">
  <NuxtButton label="添加文件" icon="i-lucide-file-plus" ... />
</label>
<label class="cursor-pointer">
  <input type="file" webkitdirectory directory multiple class="hidden" @change="onFolderSelected">
  <NuxtButton label="添加文件夹" icon="i-lucide-folder-plus" ... />
</label>
```
- `onFilesSelected`：遍历 fileList，每个文件调 `uploadFile(file)`
- `onFolderSelected`：遍历 fileList，计算 objectKey，调 `uploadFolder`
- 列表展示：MIME 图标 + 文件名 + 大小 + 上传状态

**目标前缀输入框**（新增卡片）：
```html
<NuxtInput v-model="dispatch.prefix" placeholder="如 config/2025Q3/" ... />
```

**进度区**（替换原矩阵）：
```html
<div v-for="row in selectedInstances" :key="row.id">
  <!-- 聚合行 -->
  <div @click="toggleExpand(row.id)">
    <NuxtProgress :value="progress.completed / progress.total * 100" />
    {{ progress.completed }}/{{ progress.total }} ✕{{ progress.failed }}
    <NuxtIcon :name="expanded[row.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />
  </div>
  <!-- 展开后单文件明细 -->
  <div v-if="expanded[row.id]">
    ...（复用现有 cell 渲染逻辑）
  </div>
</div>
```

**验证**（端到端）：

| 场景 | 步骤 | 预期 |
|---|---|---|
| 单文件 | 添加一个 JSON → 选实例 → 填 bucket → 分发 | MinIO Console 可见，Content-Type 正确 |
| 二进制 | 添加一个图片 → 分发 | 下载后与原文件一致 |
| 大文件 | 上传 > 8MB 文件 → 分发 | 上传成功走 multipart，不超时 |
| 文件夹 | 添加文件夹（含子目录）→ 分发 | objectKey 保留相对路径，顶层目录名去掉 |
| 目标前缀 | 填 `config/v2/` → 分发 | 文件出现在 `bucket/config/v2/` 下 |
| 聚合进度 | 上述任一场景 | 聚合视图显示完成数/总数，可展开看明细 |
| 失败重试 | 关掉某实例 MinIO → 分发 → 重启 → 点重试 | 失败标记清晰，重试成功 |
| 移除文件 | 添加文件后点 ✕ | 前端移除 + 后端暂存删除 |

**完成标志**：所有场景通过，前端与后端联调正常。

---

## 任务 5：收尾

**目标**：更新文档、确认构建通过。

**改动文件**：

| 文件 | 改动 |
|---|---|
| `docs/DEPLOY.md` | 新增 5 个环境变量（`UPLOAD_DIR`/`MAX_UPLOAD_SIZE`/`MULTIPART_THRESHOLD`/`MULTIPART_PART_SIZE`/`UPLOAD_TTL_HOURS`）；新增 Nginx `client_max_body_size` 配置说明 |
| `docs/DESIGN.md` | 移除已废弃实例 `bucket` 字段描述；更新分发能力说明为 v2（支持任意类型/文件夹/大文件/目标前缀） |
| `docs/TECH.md` | 同步：`DispatchRequest` 改型；新增 `StoredFile`；新增上传 API 规格；新增 `uploadObject`/multipart 说明；移除实例 `bucket` 字段描述 |
| `nuxt.config.ts` | 确认上传路由 body limit（如需配置 `routeRules`） |

**验证**：

```bash
bun run build
# 期望：构建成功，无错误

bun run .output/server/index.mjs
# 期望：可启动，访问 http://localhost:3000 正常
```

**完成标志**：`bun run build` 通过，`.output` 可启动，文档与代码一致。

---

## 全局验收清单

完成所有任务后，逐项验证：

| # | 场景 | 预期 |
|---|---|---|
| 1 | 上传单个 JSON 文件并分发 | MinIO 中 Content-Type 为 `application/json`，Console 可预览 |
| 2 | 上传单个图片/压缩包并分发 | Content-Type 正确，下载后二进制无损坏 |
| 3 | 上传 >8MB 大文件并分发 | 走 multipart，上传成功，文件大小一致 |
| 4 | 上传文件夹（含子目录）并分发 | objectKey 保留相对路径，顶层目录名被去掉 |
| 5 | 填写目标前缀分发 | 文件分发到 `bucket/prefix/` 下 |
| 6 | 按实例指定不同 bucket 分发 | 各实例文件分别落到对应 bucket |
| 7 | 多实例并发分发 | 进度聚合视图正确，并发数受控 |
| 8 | 分发中某实例失败 | 失败标记清晰，可重试 |
| 9 | 移除已选文件 | 前端移除 + 后端暂存文件删除 |
| 10 | 进程重启 | 暂存元数据丢失但磁盘文件在，cleanup 定时回收孤儿 |
| 11 | 生产构建 | `bun run build` 通过，`.output` 可启动 |