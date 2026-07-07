# miniops 技术文档

> 本文档基于 [DESIGN.md](./DESIGN.md)，从技术实现角度详细描述架构、数据模型、API 规格、前端组件设计、关键算法等。

---

## 一、系统架构

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    控制中心服务器                         │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  浏览器       │    │  Nuxt 全栈应用 (Bun 运行)     │   │
│  │  (实施人员)   │◄──►│                              │   │
│  │              │    │  ┌─────────┐ ┌────────────┐  │   │
│  └──────────────┘    │  │ 前端 SSR │ │ 后端 Nitro │  │   │
│      HTTP/SSE        │  │ Vue 3    │ │ server/api │  │   │
│                      │  └─────────┘ └──────┬─────┘  │   │
│                      └─────────────────────┼────────┘   │
└────────────────────────────────────────────┼────────────┘
                                             │ S3 协议
                          ┌──────────────────┼──────────────────┐
                          │                  │                  │
                    ┌─────┴─────┐     ┌──────┴─────┐    ┌──────┴─────┐
                    │ 车站 1     │     │ 车站 2     │    │ 车站 N     │
                    │ MinIO      │     │ MinIO      │    │ MinIO      │
                    │ :9000      │     │ :9000      │    │ :9000      │
                    └────────────┘     └────────────┘    └────────────┘
```

### 1.2 代理模式

浏览器**不直接连接**各 MinIO 实例。所有 S3 操作由后端 Nitro 服务代理完成。

- **安全**：MinIO 密钥存储在后端，不暴露给浏览器
- **网络**：浏览器只需访问控制中心一个地址，无需接入各车站内网
- **控制**：后端统一控制并发、重试、进度收集

### 1.3 运行环境

| 项 | 说明 |
|---|---|
| 运行时 | Bun（开发 `bun run dev`，生产 `bun run .output/server/index.mjs`） |
| 开发端口 | 3000（默认） |
| 生产部署 | Nitro 产物，用 Bun 运行；建议配合 pm2 / systemd 守护 |
| Node 兼容 | 也可用 Node.js 18+ 运行 Nitro 产物，但推荐 Bun |

---

## 二、数据模型

### 2.1 完整类型定义

```ts
// server/types/index.ts

/** MinIO 实例 */
export interface MinioInstance {
  /** 实例 ID，全局唯一（UUID 或自增） */
  id: string
  /** 归属的实例组 ID */
  groupId: string
  /** 实例名称，业务语义由用户自由填写，如"人民广场站" */
  name: string
  /** MinIO 端点，如 http://10.24.0.10:9000 */
  endpoint: string
  /** 访问密钥 */
  accessKey: string
  /** 秘密密钥 */
  secretKey: string
  /** 是否启用 */
  enabled: boolean
}

> **已知技术债**：早期设计中 `MinioInstance` 有 `bucket` 字段，已废弃。分发时通过 `instanceBuckets` 按实例指定 bucket，bucket 候选实时从 MinIO `ListBuckets` API 拉取。

/** 实例组 */
export interface InstanceGroup {
  /** 组 ID，全局唯一 */
  id: string
  /** 组名称，如"1号线"、"默认" */
  name: string
  /** 组描述 */
  description?: string
  /** 组内实例列表 */
  instances: MinioInstance[]
  /** 是否为系统内置组（如"默认"组），内置组不可删除 */
  isDefault?: boolean
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
}

/** 暂存的上传文件 */
export interface StoredFile {
  /** 文件 ID */
  id: string
  /** 原始文件名 */
  name: string
  /** 分发到 MinIO 时的对象 key */
  objectKey: string
  /** 文件大小（字节） */
  size: number
  /** 推断的 MIME 类型 */
  contentType: string
  /** 磁盘相对路径（相对 UPLOAD_DIR） */
  storedPath: string
  /** 上传完成时间（ISO 字符串） */
  uploadedAt: string
}

/** 分发任务请求 */
export interface DispatchRequest {
  /** 要分发的文件列表（引用暂存文件的 id，可选覆盖 objectKey） */
  files: { id: string; objectKey?: string }[]
  /** 选中的实例组 ID（展开为组内所有 enabled 实例） */
  groupIds: string[]
  /** 单独勾选的实例 ID（与 groupIds 合并去重） */
  instanceIds: string[]
  /** 分发目标 bucket，全局覆盖 */
  bucket?: string
  /** 按实例指定 bucket，优先级高于 bucket */
  instanceBuckets?: Record<string, string>
  /** 可选目标前缀，分发到 bucket/prefix/ 下 */
  prefix?: string
}

/** 单个文件分发结果 */
export interface DispatchResult {
  groupId: string
  instanceId: string
  instanceName: string
  fileName: string
  status: 'success' | 'failed'
  error?: string
  /** 耗时（毫秒） */
  duration?: number
}

/** 分发任务 */
export interface DispatchTask {
  id: string
  request: DispatchRequest
  status: 'pending' | 'running' | 'done'
  /** 展开后的目标实例列表（去重后） */
  resolvedInstances: MinioInstance[]
  /** 展开后的文件列表（从 request.files 的 id 解析出的 StoredFile） */
  resolvedFiles: StoredFile[]
  results: DispatchResult[]
  createdAt: string
  finishedAt?: string
}

/** SSE 推送的事件 */
export interface DispatchEvent {
  type: 'start' | 'progress' | 'complete'
  taskId: string
  /** progress 事件携带 */
  result?: DispatchResult
  /** complete 事件携带 */
  summary?: {
    total: number
    success: number
    failed: number
  }
}

/** 连通性测试结果 */
export interface ConnectivityResult {
  instanceId: string
  instanceName: string
  endpoint: string
  online: boolean
  latency?: number  // 毫秒
  error?: string
}
```

### 2.2 数据存储格式

**`server/data/groups.json`**

```json
[
  {
    "id": "grp-default",
    "name": "默认",
    "description": "未分组的实例",
    "isDefault": true,
    "createdAt": "2025-07-15T10:00:00.000Z",
    "updatedAt": "2025-07-15T10:00:00.000Z",
    "instances": []
  },
  {
    "id": "grp-001",
    "name": "1号线",
    "description": "1号线全部车站",
    "createdAt": "2025-07-15T10:00:00.000Z",
    "updatedAt": "2025-07-15T10:00:00.000Z",
    "instances": [
      {
        "id": "inst-001",
        "groupId": "grp-001",
        "name": "人民广场站",
        "endpoint": "http://10.24.0.10:9000",
        "accessKey": "minioadmin",
        "secretKey": "minioadmin",
        "bucket": "ndm",
        "enabled": true
      }
    ]
  }
]
```

### 2.3 数据访问层

`server/utils/store.ts` 封装所有数据读写，确保：
- 读写原子性（读后改再写回，用锁避免并发冲突）
- 默认组在首次初始化时自动创建
- 删除组时，组内实例一并删除（级联）
- ID 生成用 `crypto.randomUUID()`

```ts
// server/utils/store.ts 核心接口（伪代码）
export async function getGroups(): Promise<InstanceGroup[]>
export async function getGroup(id: string): Promise<InstanceGroup | null>
export async function createGroup(data: Omit<InstanceGroup, 'id' | 'instances' | 'createdAt' | 'updatedAt'>): Promise<InstanceGroup>
export async function updateGroup(id: string, data: Partial<InstanceGroup>): Promise<InstanceGroup>
export async function deleteGroup(id: string): Promise<void>
export async function addInstance(groupId: string, data: Omit<MinioInstance, 'id' | 'groupId'>): Promise<MinioInstance>
export async function updateInstance(groupId: string, instanceId: string, data: Partial<MinioInstance>): Promise<MinioInstance>
export async function deleteInstance(groupId: string, instanceId: string): Promise<void>
export async function duplicateInstance(groupId: string, instanceId: string): Promise<MinioInstance>
export async function importGroups(groups: InstanceGroup[]): Promise<{ added: number; updated: number }>
export async function exportGroups(): Promise<InstanceGroup[]>
```

---

## 三、后端 API 规格

### 3.1 实例组管理

#### GET `/api/groups`
获取所有实例组（含嵌套实例）。

**响应** `200 OK`
```json
[
  { "id": "grp-default", "name": "默认", ... }
]
```

#### POST `/api/groups`
新增实例组。

**请求体**
```json
{ "name": "2号线", "description": "2号线全部车站" }
```
**响应** `201 Created`
```json
{ "id": "grp-002", "name": "2号线", "instances": [], ... }
```

#### PUT `/api/groups/:id`
更新实例组信息（名称、描述）。组内实例的增删改通过下述单独接口完成。

**请求体**
```json
{ "name": "2号线（更新）", "description": "..." }
```
**响应** `200 OK`

#### DELETE `/api/groups/:id`
删除实例组。组内实例一并删除。内置"默认"组不可删除（返回 `403`）。

**响应** `204 No Content`

### 3.2 组内实例管理

#### POST `/api/groups/:id/instances`
在指定组内新增实例。

**请求体**
```json
{
  "name": "人民广场站",
  "endpoint": "http://10.24.0.10:9000",
  "accessKey": "minioadmin",
  "secretKey": "minioadmin",
  "bucket": "ndm",
  "enabled": true
}
```
**响应** `201 Created`

#### PUT `/api/groups/:id/instances/:instanceId`
更新组内指定实例。

**响应** `200 OK`

#### DELETE `/api/groups/:id/instances/:instanceId`
删除组内指定实例。

**响应** `204 No Content`

#### POST `/api/groups/:id/instances/:instanceId/duplicate`
复制实例（在组内创建副本，名称加"(副本)"后缀）。

**响应** `201 Created`

### 3.3 连通性测试

#### POST `/api/groups/:id/test`
测试组内所有实例的连通性。后端对每个实例发起 S3 `listBuckets` 或 `headBucket` 请求。

**响应** `200 OK`
```json
[
  { "instanceId": "inst-001", "instanceName": "人民广场站", "endpoint": "http://...", "online": true, "latency": 23 },
  { "instanceId": "inst-002", "instanceName": "南京东路站", "endpoint": "http://...", "online": false, "error": "ECONNREFUSED" }
]
```

### 3.4 导入/导出

#### POST `/api/groups/import`
导入实例组 JSON（覆盖模式：按 id 匹配，有则更新、无则新增）。

**请求体**: `InstanceGroup[]` JSON

**响应** `200 OK`
```json
{ "added": 2, "updated": 1 }
```

#### GET `/api/groups/export`
导出当前所有实例组为 JSON 文件。

**响应** `200 OK` `Content-Type: application/json`
`Content-Disposition: attachment; filename="miniops-groups-export.json"`

### 3.5 文件上传暂存

#### POST `/api/uploads`
multipart 上传单个文件到暂存目录，返回 `StoredFile`。

**请求体** `multipart/form-data`，字段名 `file`

**响应** `201 Created`
```json
{
  "id": "uf-xxx",
  "name": "config.json",
  "objectKey": "config.json",
  "size": 1024,
  "contentType": "application/json",
  "storedPath": "uf-xxx/config.json",
  "uploadedAt": "2026-07-07T..."
}
```

#### DELETE `/api/uploads/:id`
删除暂存文件（磁盘 + 内存记录）。

**响应** `204 No Content`

### 3.6 文件分发

#### POST `/api/dispatch`
提交分发任务。后端立即创建任务并返回 taskId，后台异步执行。

**请求体**
```json
{
  "files": [
    { "id": "uf-xxx", "objectKey": "config.json" }
  ],
  "groupIds": ["grp-001"],
  "instanceIds": [],
  "instanceBuckets": { "inst-001": "ndm" },
  "prefix": "config/v2/"
}
```

**响应** `202 Accepted`
```json
{ "taskId": "task-xxx" }
```

#### GET `/api/dispatch/events?taskId=task-xxx`
SSE 流，实时推送分发进度。

**响应** `Content-Type: text/event-stream`

每个事件格式：
```
event: progress
data: {"type":"progress","taskId":"task-xxx","result":{"groupId":"grp-001","instanceId":"inst-001","instanceName":"人民广场站","fileName":"ndm-lines.json","status":"success","duration":152}}

event: complete
data: {"type":"complete","taskId":"task-xxx","summary":{"total":5,"success":4,"failed":1}}
```

---

## 四、MinIO 操作封装

### 4.1 `server/utils/minio.ts`

所有 MinIO 操作均为纯 `node:crypto` + 原生 `fetch` 的手写 SigV4 实现，零 SDK 依赖。

```ts
import { createHash, createHmac } from 'node:crypto'
import { statSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import type { MinioInstance } from '../types'

/** 生成 AWS SigV4 预签名 PUT URL */
function presignPutUrl(opts: { ... }): string { ... }

/** 生成 AWS SigV4 Authorization 头（通用，支持任意 method/query/payloadHash） */
function signRequest(opts: { ... }): { authorization: string, amzDate: string } { ... }

/** 上传 JSON 文件（V1，保留向后兼容） */
export async function uploadJson(instance, bucket, filename, content: string): Promise<void> { ... }

/** V2 统一上传入口：从磁盘文件上传，按大小自动选择单次 PUT 或 multipart */
export async function uploadObject(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  localPath: string,
  contentType: string,
): Promise<void> {
  const size = statSync(localPath).size
  if (size < MULTIPART_THRESHOLD) {
    await uploadSmall(instance, bucket, objectKey, localPath, contentType)
  } else {
    await uploadLarge(instance, bucket, objectKey, localPath, contentType)
  }
}

/** 小文件：复用 presignPutUrl，body 从磁盘读取 */
async function uploadSmall(...) { ... }

/** 大文件：手写 S3 Multipart Upload 三步（Initiate → UploadPart ×N → Complete） */
async function uploadLarge(...) { ... }

/** 中止 multipart upload（清理 MinIO 侧残留） */
async function abortMultipartUpload(...) { ... }

/** Content-Type 推断 */
export function inferContentType(filename: string): string { ... }

/** objectKey 清洗（防 path traversal） */
export function sanitizeObjectKey(key: string): string { ... }

/** ListBuckets（实时拉取实例的 bucket 列表） */
export async function listBuckets(instance: MinioInstance): Promise<ListBucketsResult> { ... }

/** 连通性测试（请求 /minio/health/live） */
export async function testConnectivity(instance: MinioInstance): Promise<ConnectivityResult> { ... }
```

### 4.2 分发执行器

`server/utils/dispatcher.ts` 负责并发调度：

```ts
/**
 * 分发执行器
 * - 实例维度并发（默认 5）
 * - 每个实例内文件串行上传
 * - 每个文件完成后通过 SSE 推送进度
 */
export async function executeDispatch(task: DispatchTask): Promise<void> {
  const instances = task.resolvedInstances
  const files = task.resolvedFiles
  const bucket = task.request.bucket
  // ...信号量并发控制...
  // processInstance(task.id, instance, files, bucket, task.request.instanceBuckets, task.request.prefix)
}

async function processInstance(
  taskId: string,
  instance: MinioInstance,
  files: StoredFile[],
  bucketOverride: string | undefined,
  instanceBuckets?: Record<string, string>,
  prefix?: string,
) {
  const targetBucket = instanceBuckets?.[instance.id] || bucketOverride
  for (const f of files) {
    const objectKey = prefix ? `${prefix.replace(/\/+$/, '')}/${f.objectKey}` : f.objectKey
    const localPath = resolve(UPLOAD_DIR, f.storedPath)
    try {
      await uploadObject(instance, targetBucket, objectKey, localPath, f.contentType)
      // 推送 success
    } catch (e) {
      // 推送 failed
    }
  }
}
```

### 4.3 SSE 实现

Nuxt/Nitro 原生支持 SSE，使用 `eventStream`：

```ts
// server/api/dispatch/events.get.ts
export default defineEventHandler((event) => {
  const { taskId } = getQuery(event);
  const stream = createEventStream(event);

  // 注册到任务的事件分发器
  dispatcher.subscribe(taskId, (result) => {
    stream.push(JSON.stringify({ type: 'progress', taskId, result }));
  });

  stream.onClosed(() => {
    dispatcher.unsubscribe(taskId);
  });

  return stream.send();
});
```

---

## 五、前端设计

### 5.1 布局组件

`app/components/AppLayout.vue` —— Dashboard 布局：

```
┌─────────────────────────────────────────────────┐
│ NuxtHeader: [miniops logo]     [色盲切换] [暗色] │
├──────────┬──────────────────────────────────────┤
│          │                                      │
│ NuxtSide │                                      │
│  bar     │        <slot /> (页面内容)            │
│          │                                      │
│ 总览     │                                      │
│ 实例     │                                      │
│ 运维 ▸   │                                      │
│  文件分发│                                      │
│          │                                      │
└──────────┴──────────────────────────────────────┘
```

侧边栏导航项配置：
```ts
const navItems = [
  { label: '总览', to: '/', icon: 'i-lucide-layout-dashboard' },
  { label: '实例', to: '/groups', icon: 'i-lucide-server' },
  {
    label: '运维',
    icon: 'i-lucide-wrench',
    children: [
      { label: '文件分发', to: '/ops/dispatch', icon: 'i-lucide-send' },
    ],
  },
];
```

### 5.2 页面组件设计

#### `app/pages/index.vue` — 总览

- 使用 `NuxtCard` 展示统计卡片（实例组数、实例总数、在线/离线）
- 使用 `NuxtButton` 快速入口
- 数据通过 `useFetch('/api/groups')` 获取

#### `app/pages/groups/index.vue` — 实例

- **组列表**: `NuxtTable`（列：名称、描述、实例数、操作）
- **组表单**: `NuxtModal` + `NuxtForm`（新增/编辑组）
- **组详情/实例管理**: 点击组行展开，内嵌实例 `NuxtTable`
  - 列：名称、endpoint、bucket、状态、操作
  - 操作：编辑(`NuxtModal`)、复制、删除、测试连通性、启用/禁用
- **导入/导出**: `NuxtButton` + `NuxtFileUpload`(import) / 下载链接(export)

#### `app/pages/ops/dispatch/index.vue` — 文件分发

- **文件选择**: `NuxtFileUpload`（multiple, accept=".json"）
  - 读取文件内容存入 `files` 数组
- **目标选择**: 分组 `NuxtTable`（可展开行）
  - 组行带 checkbox（勾选=全选组内 enabled 实例）
  - 实例行带 checkbox
  - 父子 checkbox 联动
- **bucket 选择器**: `NuxtSelect`
  - 候选项 = 选中实例的 bucket 去重
  - watch 选中实例变化 → 更新候选
- **执行**: `NuxtButton` → `POST /api/dispatch`
- **进度展示**: 实例级聚合折叠视图 + `NuxtProgress`
  - `EventSource('/api/dispatch/events?taskId=...')` 监听 SSE
  - 每收到 progress 事件，更新对应单元格状态
- **重试**: 失败实例 `NuxtButton` → 重新提交该实例的分发（复用暂存 fileId）

### 5.3 前端 Composable

```ts
// app/composables/useDispatch.ts
export function useDispatch() {
  const files = ref<StoredFile[]>([]);
  const prefix = ref('');
  const uploadStates = ref<Record<string, 'uploading' | 'ready' | 'error'>>({});
  const selectedInstanceIds = ref<Set<string>>(new Set());
  const instanceBuckets = ref<Record<string, string>>({});
  const progress = ref<Record<string, CellStatus>>({});
  const isRunning = ref(false);

  // 异步上传文件到暂存
  async function addFiles(fileList: FileList) { ... }
  async function addFolder(fileList: FileList) { ... }
  async function removeUpload(id: string) { ... }

  // 实例级聚合进度
  function getInstanceProgress(instanceId: string) { ... }

  // 提交分发
  async function submit(groups: InstanceGroup[]) {
    const { taskId } = await $fetch('/api/dispatch', {
      method: 'POST',
      body: { files: files.value.map(f => ({ id: f.id, objectKey: f.objectKey })), ..., prefix: prefix.value }
    });
    // 建立 SSE 连接
    const es = new EventSource(`/api/dispatch/events?taskId=${taskId}`);
    es.addEventListener('progress', (e) => { ... });
    es.addEventListener('complete', () => { isRunning.value = false; es.close(); });
  }

  return { files, prefix, uploadStates, selectedInstanceIds, instanceBuckets, progress, isRunning, addFiles, addFolder, removeUpload, getInstanceProgress, submit, ... };
}
```

---

## 六、关键技术问题与解决方案

### 6.1 Content-Type 修复

**问题**: SDK 的 `write(string)` 会把 `application/json` 改写为 `application/json;charset=utf-8`，MinIO Console 预览不识别。

**解决**: 纯手写 SigV4 预签名 PUT URL + 原生 `fetch` 上传，手动指定 `Content-Type`。已封装在 `uploadSmall()` / `uploadObject()` 中。

### 6.2 并发控制

**问题**: 一次性向几十个 MinIO 实例上传文件，可能打满控制中心带宽或触发连接数限制。

**解决**: 信号量模式并发控制，实例维度并发（默认 5），每个实例内文件串行。并发数可通过环境变量 `DISPATCH_CONCURRENCY` 配置。

### 6.3 SSE 连接管理

**问题**: 分发任务是长时操作，需要实时推送进度。

**解决**: Nitro 的 `createEventStream` 原生支持 SSE。前端用 `EventSource` 监听。需要注意：
- 断线重连：`EventSource` 自动重连，后端需支持 taskId 恢复
- 连接清理：前端关闭页面时 `es.close()`，后端 `stream.onClosed` 注销

### 6.4 数据并发读写

**问题**: 多个请求同时读写 `groups.json` 可能导致数据损坏。

**解决**: `store.ts` 内部用互斥锁（简单的 Promise 队列）保证写操作串行化。读操作直接读文件（允许读到稍旧数据，不影响功能）。

### 6.5 文件内容传输

**问题**: 前端选多个 JSON 文件，需要把文件名 + 内容传给后端。

**方案**: 前端用 `FileReader.readAsText()` 读取文件内容，组装成 `{ name, content }[]` 放入 POST 请求体。对于大文件（几 MB）也够用，不走 multipart。

---

## 七、目录结构（完整）

```
miniops/
├── app/
│   ├── app.vue                         # 根组件
│   ├── assets/css/main.css             # Tailwind + Nuxt UI
│   ├── components/
│   │   └── AppLayout.vue               # Dashboard 布局
│   ├── composables/
│   │   └── useDispatch.ts              # 分发逻辑
│   └── pages/
│       ├── index.vue                   # 总览
│       ├── groups/index.vue            # 实例管理
│       └── ops/dispatch/index.vue      # 文件分发
├── server/
│   ├── api/
│   │   ├── groups/
│   │   │   ├── index.get.ts            # GET    /api/groups
│   │   │   ├── index.post.ts           # POST   /api/groups
│   │   │   ├── [id].put.ts             # PUT    /api/groups/:id
│   │   │   ├── [id].delete.ts          # DELETE /api/groups/:id
│   │   │   ├── [id]/test.post.ts       # POST   /api/groups/:id/test
│   │   │   ├── [id]/
│   │   │   │   ├── instances.post.ts          # POST   /api/groups/:id/instances
│   │   │   │   ├── instances/[instanceId].put.ts    # PUT
│   │   │   │   ├── instances/[instanceId].delete.ts # DELETE
│   │   │   │   └── instances/[instanceId]/duplicate.post.ts # POST duplicate
│   │   │   ├── import.post.ts          # POST   /api/groups/import
│   │   │   └── export.get.ts           # GET    /api/groups/export
│   │   └── dispatch/
│   │       ├── index.post.ts           # POST   /api/dispatch
│   │       └── events.get.ts           # GET    /api/dispatch/events (SSE)
│   ├── data/
│   │   └── groups.json                 # 数据文件
│   ├── types/
│   │   └── index.ts                    # 类型定义
│   └── utils/
│       ├── minio.ts                    # MinIO S3 操作
│       ├── store.ts                    # 数据读写
│       └── dispatcher.ts              # 分发执行器
├── docs/
│   ├── DESIGN.md
│   ├── TECH.md                         # ← 本文档
│   └── PLAN.md
├── nuxt.config.ts
├── package.json
└── tsconfig.json
```
