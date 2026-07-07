# 文件分发能力扩展 · 技术方案

> 版本：v2（DISPATCH-V2）
> 关联文档：[DESIGN.md](./DESIGN.md)、[TECH.md](./TECH.md)、[实施计划](./DISPATCH-V2-PLAN.md)
> 目标：把分发能力从"只支持小 JSON 字符串"升级为"支持任意类型文件、整个文件夹、大文件（GB 级）"。
> 本阶段**不涉及**：数据库存储、分发历史持久化、定时任务、用户认证。这些留待后续版本。

---

## 一、背景与现状

### 1.1 当前能力与边界

MVP 的文件分发已稳定可用：

- 多文件选择 → 分组 checkbox 联动 → bucket 从 MinIO 实时 `ListBuckets` 拉取 → 并发上传（默认 5）→ SSE 进度矩阵 → 失败重试
- 但**只能分发 JSON 文本文件**，且文件内容以字符串形式塞进 `POST /api/dispatch` 的请求体

### 1.2 当前的三个根本限制

这三个限制都源于 `files` 这个数据结构：

```ts
// server/types/index.ts 现状
interface DispatchRequest {
  files: { name: string; content: string }[]   // ← content 是字符串
  groupIds: string[]
  instanceIds: string[]
  bucket?: string
  instanceBuckets?: Record<string, string>
}
```

1. **只能放文本** —— 二进制（图片、压缩包、模型、视频）序列化进 JSON 会损坏。
2. **整批文件塞进单个 POST body** —— 大文件会撑爆 HTTP 请求体，无法分片续传。
3. **上传函数只接受 string** —— `uploadJson(instance, bucket, filename, content: string)` 用手写 SigV4 预签名 PUT，body 传字符串，无法做 multipart。

### 1.3 决定性物理约束

浏览器上传到控制中心的 `ReadableStream`（Web 标准）是**一次性消费**的：一旦被某个消费者读取即被锁定，无法同时喂给多个不同凭据的 MinIO 实例。

这意味着"一份数据分发给 N 个实例"无法通过"流式转发到 N 个 client"实现，必须先在控制中心**落盘暂存**，再各自分发。这是新架构的基线。

### 1.4 技术路线决策：纯手写 SigV4，不引入 S3Client

当前项目所有 MinIO 操作（`uploadJson`、`listBuckets`）均为纯 `node:crypto` + 原生 `fetch` 的手写 SigV4 实现，零 SDK 依赖。本版本**延续这一路线**：

| 理由 | 说明 |
|---|---|
| 风格统一 | 全部 MinIO 交互保持单一实现风格，无 SDK 黑盒 |
| Content-Type 精确控制 | 手写预签名 PUT 可精确指定 `Content-Type`，规避 SDK 对文本自动追加 `;charset=utf-8` 导致 MinIO Console 预览 JSON 失败的老问题 |
| listBuckets 本就手写 | Bun `S3Client` 不支持 `ListBuckets` API，该项目此能力一直是手写的；既然 listBuckets 必须手写，上传也手写可保持一致 |
| multipart 无需新签名代码 | 现有 `signRequest()` 函数已是通用的（支持任意 method / query / payloadHash），S3 Multipart Upload 的三步 API 全部能复用它 |
| 并发与重试自控 | 不受 SDK 的 `partSize`/`queueSize` 黑盒参数约束 |

---

## 二、新架构：三段式

```
浏览器                         控制中心 (Nitro + Bun)              N 个 MinIO 实例
  │  ① 逐文件 multipart 上传              ② 暂存磁盘
  │ ───────────────────────────────────► server/data/uploads/<id>/<name>
  │                                                              (内存 Map 记录元数据)
  │  ③ POST /dispatch { fileIds }
  │ ───────────────────────────────────►  ④ 读磁盘，逐实例分发 ──────► MinIO
  │                                       (SSE 推进度) ◄──────────
```

**核心变化**：文件不再塞进 `/dispatch` 的请求体，而是先上传、暂存、换得 `fileId`，分发任务只持有 `fileId` 列表。这与"流不可复用 → 必须暂存"的约束天然契合。

---

## 三、数据模型变更

### 3.1 新增类型

```ts
// server/types/index.ts

/** 暂存的上传文件 */
export interface StoredFile {
  /** 文件 ID */
  id: string
  /** 原始文件名，如 "config.json" */
  name: string
  /** 分发到 MinIO 时的对象 key。单文件 = 文件名；文件夹内文件 = 相对路径，如 "sub/a.json" */
  objectKey: string
  /** 文件大小（字节） */
  size: number
  /** 推断的 MIME 类型 */
  contentType: string
  /** 磁盘相对路径（相对 UPLOAD_DIR），如 "uf-xxx/config.json" */
  storedPath: string
  /** 上传完成时间（ISO 字符串） */
  uploadedAt: string
}
```

### 3.2 请求体变更

```ts
// server/types/index.ts

/** 分发任务请求（v2） */
export interface DispatchRequest {
  /** 要分发的文件列表（引用暂存文件的 id，可选覆盖 objectKey） */
  files: { id: string; objectKey?: string }[]
  /** 选中的实例组 ID */
  groupIds: string[]
  /** 单独勾选的实例 ID */
  instanceIds: string[]
  /** 分发目标 bucket，全局覆盖（向后兼容） */
  bucket?: string
  /** 按实例指定 bucket，优先级高于 bucket */
  instanceBuckets?: Record<string, string>
  /** 可选目标前缀，分发到 bucket/prefix/ 下。文件夹分发时常用 */
  prefix?: string
}
```

> **向后兼容**：这是 MVP，无外部调用方，直接替换旧字段，不维护双版本。

### 3.3 DispatchTask 扩展

```ts
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
```

---

## 四、MinIO 上传函数升级（核心）

### 4.1 统一入口

当前 `uploadJson(instance, bucket, filename, content: string)` 只支持字符串。升级为统一的 `uploadObject`，输入是**磁盘文件路径**，按大小自动选择单次 PUT 或 multipart：

```ts
// server/utils/minio.ts

/**
 * 上传一个磁盘文件到 MinIO。
 *
 * - 小文件（< MULTIPART_THRESHOLD）：单次 PUT，复用 presignPutUrl，精确控制 Content-Type
 * - 大文件（≥ MULTIPART_THRESHOLD）：手写 S3 Multipart Upload（3 步）
 *
 * 签名全部复用现有的 signRequest() / presignPutUrl()，零新增签名代码。
 */
export async function uploadObject(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  localPath: string,
  contentType: string,
): Promise<void>
```

### 4.2 小文件路径（< 阈值，默认 8MB）

直接复用现有 `presignPutUrl` 的逻辑，只是 body 从字符串改为文件 buffer：

```ts
import { BunFile } from 'bun'

async function uploadSmall(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  localPath: string,
  contentType: string,
): Promise<void> {
  const file: BunFile = Bun.file(localPath)
  const buffer = await file.arrayBuffer()

  const presignedUrl = presignPutUrl({
    endpoint: instance.endpoint,
    bucket,
    objectKey,
    accessKey: instance.accessKey,
    secretKey: instance.secretKey,
    region: 'us-east-1',
    expiresIn: 3600,
  })

  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: buffer,
    headers: { 'Content-Type': contentType },   // 精确控制，JSON 不会带 ;charset=utf-8
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`上传失败: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 200)}` : ''}`)
  }
}
```

> `presignPutUrl`、`signRequest` 两个签名函数**已存在且无需修改**。

### 4.3 大文件路径（≥ 阈值）：手写 S3 Multipart Upload

S3 Multipart Upload 是三个标准 API，全部用现有 `signRequest()` 签名。MinIO 完全兼容 AWS SigV4，接受 `UNSIGNED-PAYLOAD` 作为 payloadHash，因此流式上传无需计算 body 的 sha256。

#### 步骤 ① 创建上传（Initiate Multipart Upload）

```
POST /{bucket}/{key}?uploads HTTP/1.1
Host: <endpoint>
Content-Type: <contentType>
（Authorization 头由 signRequest 生成）
```

响应为 XML：
```xml
<InitiateMultipartUploadResult>
  <Bucket>ndm</Bucket>
  <Key>bigfile.zip</Key>
  <UploadId>VXBsb2Qk...</UploadId>
</InitiateMultipartUploadResult>
```

用正则从 XML 提取 `<UploadId>`。

#### 步骤 ② 上传分片（Upload Part）

```
PUT /{bucket}/{key}?partNumber={N}&uploadId={uploadId} HTTP/1.1
Host: <endpoint>
body: <分片二进制>
（payloadHash = UNSIGNED-PAYLOAD）
```

响应头 `ETag` 即该分片的标识，需收集。分片号从 1 开始（S3 规范），最大 10000。

#### 步骤 ③ 完成上传（Complete Multipart Upload）

```
POST /{bucket}/{key}?uploadId={uploadId} HTTP/1.1
Host: <endpoint>
body:
<CompleteMultipartUpload>
  <Part><PartNumber>1</PartNumber><ETag>"etag1"</ETag></Part>
  <Part><PartNumber>2</PartNumber><ETag>"etag2"</ETag></Part>
  ...
</CompleteMultipartUpload>
```

body 是 XML 字符串，**这里的 payloadHash 需要计算 body 的实际 sha256**（不能用 `UNSIGNED-PAYLOAD`，因为这是完整 body）。

#### 参考实现

```ts
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { resolve } from 'node:path'

const MULTIPART_THRESHOLD = Number(process.env.MULTIPART_THRESHOLD) || 8 * 1024 * 1024  // 8MB
const PART_SIZE = Number(process.env.MULTIPART_PART_SIZE) || 5 * 1024 * 1024             // 5MB

async function uploadLarge(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  localPath: string,
  contentType: string,
): Promise<void> {
  const endpoint = instance.endpoint.replace(/\/+$/, '')
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
  const path = `/${bucket}/${encodedKey}`

  // ① 创建 multipart upload
  const createQuery = 'uploads='
  const { authorization: a1, amzDate: d1 } = signRequest({
    method: 'POST', endpoint, path, queryString: createQuery,
    accessKey: instance.accessKey, secretKey: instance.secretKey,
    region: 'us-east-1', payloadHash: EMPTY_SHA256,
  })
  const createRes = await fetch(`${endpoint}${path}?uploads`, {
    method: 'POST',
    headers: { 'Host': new URL(endpoint).host, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': d1, 'Authorization': a1, 'Content-Type': contentType },
  })
  if (!createRes.ok) throw new Error(`创建 multipart 失败: ${createRes.status} ${await createRes.text().catch(() => '')}`)
  const uploadId = extractXmlTag(await createRes.text(), 'UploadId')
  if (!uploadId) throw new Error('未拿到 UploadId')

  // ② 逐片上传
  const size = statSync(localPath).size
  const parts: { partNumber: number; etag: string }[] = []
  const partCount = Math.ceil(size / PART_SIZE)

  try {
    for (let n = 1; n <= partCount; n++) {
      const start = (n - 1) * PART_SIZE
      const end = Math.min(start + PART_SIZE, size)
      const chunk = Buffer.alloc(end - start)
      const fd = await open(localPath, 'r')
      await fd.read(chunk, 0, chunk.length, start)
      await fd.close()

      const partQuery = `partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`
      const { authorization: a2, amzDate: d2 } = signRequest({
        method: 'PUT', endpoint, path, queryString: partQuery,
        accessKey: instance.accessKey, secretKey: instance.secretKey,
        region: 'us-east-1', payloadHash: UNSIGNED_PAYLOAD,
      })
      const partRes = await fetch(`${endpoint}${path}?${partQuery}`, {
        method: 'PUT', body: chunk,
        headers: { 'Host': new URL(endpoint).host, 'x-amz-content-sha256': UNSIGNED_PAYLOAD, 'x-amz-date': d2, 'Authorization': a2 },
      })
      if (!partRes.ok) throw new Error(`分片 ${n}/${partCount} 上传失败: ${partRes.status}`)
      const etag = partRes.headers.get('etag')
      if (!etag) throw new Error(`分片 ${n} 未返回 ETag`)
      parts.push({ partNumber: n, etag: etag.replace(/"/g, '') })
    }

    // ③ 完成
    const completeBody = `<CompleteMultipartUpload>${parts.map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
    const completeQuery = `uploadId=${encodeURIComponent(uploadId)}`
    const { authorization: a3, amzDate: d3 } = signRequest({
      method: 'POST', endpoint, path, queryString: completeQuery,
      accessKey: instance.accessKey, secretKey: instance.secretKey,
      region: 'us-east-1', payloadHash: sha256Hex(completeBody),
    })
    const completeRes = await fetch(`${endpoint}${path}?${completeQuery}`, {
      method: 'POST', body: completeBody,
      headers: { 'Host': new URL(endpoint).host, 'x-amz-content-sha256': sha256Hex(completeBody), 'x-amz-date': d3, 'Authorization': a3, 'Content-Type': 'application/xml' },
    })
    if (!completeRes.ok) throw new Error(`完成 multipart 失败: ${completeRes.status}`)
  } catch (e) {
    // 中止上传，避免 MinIO 侧残留未完成的 upload（占用空间）
    await abortMultipartUpload(instance, bucket, objectKey, uploadId).catch(() => {})
    throw e
  }
}
```

辅助常量与函数：

```ts
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

function extractXmlTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return m?.[1] ?? null
}

async function abortMultipartUpload(instance, bucket, objectKey, uploadId) {
  // DELETE /{bucket}/{key}?uploadId=X，用 signRequest 签名
}
```

### 4.4 常量与约束（S3 规范）

| 约束 | 值 | 说明 |
|---|---|---|
| 分片最小大小 | 5MB（最后一片除外） | S3 硬性要求，`PART_SIZE` 默认 5MB 符合 |
| 分片最大大小 | 5GB | 单次 PUT 上限 |
| 最大分片数 | 10000 | 文件大小 ≤ 10000 × PART_SIZE |
| 分片号 | 1..10000 | 从 1 开始 |

按默认 `PART_SIZE=5MB`，单文件最大支持 **48GB**（10000 × 5MB）。若需更大，调大 `PART_SIZE`。

### 4.5 Content-Type 推断

新增 `inferContentType(filename)`：

```ts
const MIME_TABLE: Record<string, string> = {
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
}

export function inferContentType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  return MIME_TABLE[ext] ?? 'application/octet-stream'
}
```

---

## 五、暂存与上传 API（新增）

### 5.1 暂存管理

```ts
// server/utils/uploads.ts（新增）

/**
 * 暂存文件管理。
 *
 * - 文件落盘到 UPLOAD_DIR/<id>/<safeName>
 * - 元数据保存在内存 Map<id, StoredFile>（进程重启丢失，但磁盘文件仍在）
 * - 孤儿文件由 cleanup 定时清理（超过 UPLOAD_TTL_HOURS）
 */

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ?? resolve(process.cwd(), 'server/data/uploads')

const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 0  // 0 = 不限

/** 内存元数据表 */
const fileRegistry = new Map<string, StoredFile>()

export async function storeUpload(rawName: string, data: Buffer): Promise<StoredFile>
export function getStoredFile(id: string): StoredFile | null
export function deleteStoredFile(id: string): Promise<void>
export async function cleanupExpired(): Promise<number>  // 返回清理数量
```

### 5.2 路径安全

`objectKey` / 文件名进系统前必须 sanitize，防 path traversal：

```ts
function sanitizeObjectKey(key: string): string {
  return key
    .replace(/\\/g, '/')                 // 反斜杠归一化
    .split('/')
    .map(seg => seg.replace(/^\.+/, '')) // 去掉开头的点（防 .. 和 .）
    .filter(seg => seg.length > 0)
    .join('/')
}
```

### 5.3 上传 API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/uploads` | multipart 上传**单个**文件，流式落盘，返回 `StoredFile` |
| `DELETE` | `/api/uploads/:id` | 删除单个暂存文件（前端移除文件时调用） |

**`POST /api/uploads`** 规格：

- 请求体：`multipart/form-data`，字段名 `file`
- 流式解析：用 Nitro 的 `readMultipartFormData(event)`，取 `file` part 的 `data: Buffer`
- 大小校验：`MAX_UPLOAD_SIZE`（0 = 不限）
- 落盘：`UPLOAD_DIR/<id>/<safeName>`
- 响应：`201 Created`，返回 `StoredFile`（不含 body 内容）

```ts
// server/api/uploads/index.post.ts（伪代码）
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

**`DELETE /api/uploads/:id`** 规格：

- 删除磁盘文件 + 内存 Map 记录
- 响应：`204 No Content`

### 5.4 孤儿清理（可选，启动时 + 定时）

```ts
// server/plugins/cleanup.ts（新增，Nitro plugin）
export default defineNitroPlugin(() => {
  // 启动时清理一次
  cleanupExpired()
  // 每 6 小时清理一次
  setInterval(() => cleanupExpired(), 6 * 60 * 60 * 1000)
})
```

扫描 `UPLOAD_DIR`，删除 `uploadedAt` 超过 `UPLOAD_TTL_HOURS`（默认 24）的目录。

---

## 六、dispatcher 适配

### 6.1 任务创建

`POST /api/dispatch` 从请求体的 `files[].id` 解析出 `StoredFile`：

```ts
// server/api/dispatch/index.post.ts
const resolvedFiles: StoredFile[] = []
for (const f of body.files) {
  const stored = getStoredFile(f.id)
  if (!stored) throw createError({ statusCode: 400, statusMessage: `文件 ${f.id} 不存在或已过期` })
  // 允许请求体覆盖 objectKey（例如前端调整目标路径）
  resolvedFiles.push(f.objectKey ? { ...stored, objectKey: sanitizeObjectKey(f.objectKey) } : stored)
}
```

### 6.2 分发执行

`processInstance` 改为从磁盘文件上传：

```ts
// server/utils/dispatcher.ts
async function processInstance(
  taskId: string,
  instance: MinioInstance,
  files: StoredFile[],
  bucketOverride: string | undefined,
  instanceBuckets?: Record<string, string>,
  prefix?: string,
): Promise<void> {
  const targetBucket = instanceBuckets?.[instance.id] || bucketOverride
  const task = taskRegistry.get(taskId)!.task

  for (const f of files) {
    const result: DispatchResult = {
      groupId: instance.groupId,
      instanceId: instance.id,
      instanceName: instance.name,
      fileName: f.objectKey,   // 进度展示用 objectKey（含相对路径）
      status: 'success',
    }

    if (!targetBucket) {
      result.status = 'failed'
      result.error = '未指定 bucket'
      task.results.push(result)
      notify(taskId, { type: 'progress', taskId, result })
      continue
    }

    const objectKey = prefix
      ? `${prefix.replace(/\/+$/, '')}/${f.objectKey}`
      : f.objectKey
    const localPath = resolve(UPLOAD_DIR, f.storedPath)

    const start = Date.now()
    try {
      await uploadObject(instance, targetBucket, objectKey, localPath, f.contentType)
      result.duration = Date.now() - start
      task.results.push(result)
      notify(taskId, { type: 'progress', taskId, result })
    } catch (e: any) {
      result.status = 'failed'
      result.error = e?.message || '上传失败'
      result.duration = Date.now() - start
      task.results.push(result)
      notify(taskId, { type: 'progress', taskId, result })
    }
  }
}
```

### 6.3 并发策略

保留现有策略：**实例维度并发（默认 5）+ 实例内文件串行**。

理由：文件夹场景文件数可能很多，但大文件并发会吃满控制中心出口带宽。实例内串行最简单稳定。未来如需提速，可加文件维度并发（实例内同时传 K 个文件），但需配合带宽限速。

### 6.4 分发完成后的清理

分发全部完成后，暂存文件保留 `UPLOAD_TTL_HOURS`（默认 24h）再由 cleanup 清理。**不立即删除**，原因：
- 用户可能对失败实例重试，需要原文件。
- 大文件重新上传成本高。

---

## 七、文件夹上传

### 7.1 浏览器能力

`<input type="file" webkitdirectory>` 支持选整个文件夹，每个 `File` 对象带 `webkitRelativePath`（如 `mydir/sub/a.json`）。

### 7.2 objectKey 策略

- **顶层文件夹名去掉**：用户选了 `dist/`，应分发到 bucket 根的 `index.html`，而非 `dist/index.html`。
- 去顶后的相对路径即 `objectKey`：

```ts
const objectKey = file.webkitRelativePath
  ? file.webkitRelativePath.replace(/^[^/]+\//, '')  // 去掉第一段目录
  : file.name
```

- 若用户填了"目标前缀"，最终 key = `prefix/` + `objectKey`（在 dispatcher 里拼接，前端只管传 `objectKey`）。

### 7.3 前端交互

分发页"选择文件"区拆为两个按钮：

- **添加文件**：`<input type="file" multiple>`，不限 `accept`（原来是 `.json`）
- **添加文件夹**：`<input type="file" webkitdirectory directory multiple>`

两者产出统一进 `files` 列表（`StoredFile[]`）。文件夹上传时，前端遍历 `fileList`，**逐个**调 `POST /api/uploads`（每个文件一次请求），收集返回的 `StoredFile`。

> 浏览器原生不支持"打包成单文件上传"，所以文件夹本质是多个单文件上传。UI 上表现为一个进度条聚合。

---

## 八、前端改动清单

| 文件 | 改动 |
|---|---|
| `app/composables/useDispatch.ts` | `files` 改为 `StoredFile[]`；新增 `uploadFile(file: File): Promise<StoredFile>` 调 `/api/uploads`；新增 `removeUpload(id)` 调 `DELETE`；新增文件夹上传的批量循环；`submit` 改为只发 `{ id, objectKey }[]`；新增实例级聚合进度 `getInstanceProgress(instanceId)` |
| `app/pages/ops/dispatch/index.vue` | 文件选择拆为"添加文件"+"添加文件夹"两个按钮；去掉 `accept=".json"`；文件 tag 显示大小 + 图标（按 contentType 选 icon）；移除"读 content"逻辑，改异步上传；新增"目标前缀"输入框（可选）；进度区改聚合视图 |
| `server/api/dispatch/index.post.ts` | `files` 从 body 读 `id` 列表 → 从内存 Map 查 `StoredFile` → 组装 task（含 `resolvedFiles`） |
| `server/utils/dispatcher.ts` | `processInstance` 从磁盘文件上传；`executeDispatch` 透传 `prefix` |
| `server/utils/minio.ts` | 新增 `uploadObject`（小/大文件双路径）、`uploadLarge`（multipart 三步）、`abortMultipartUpload`、`inferContentType`、`sanitizeObjectKey`；保留 `presignPutUrl`/`signRequest`/`uploadJson`（向后兼容）/`listBuckets`/`testConnectivity` |
| `server/types/index.ts` | 新增 `StoredFile`；`DispatchRequest.files` 改型；`DispatchTask` 加 `resolvedFiles` |
| **新增** `server/api/uploads/index.post.ts` | 上传暂存文件 |
| **新增** `server/api/uploads/[id].delete.ts` | 删除暂存文件 |
| **新增** `server/utils/uploads.ts` | 暂存目录管理、内存 Map、cleanup |
| **新增** `server/plugins/cleanup.ts` | 孤儿文件定时清理 |
| `.gitignore` | 新增 `server/data/uploads/` |
| `docs/DESIGN.md`、`docs/TECH.md` | 同步：移除已废弃的实例 `bucket` 字段描述（已知技术债）；新增 v2 分发能力说明 |

---

## 九、进度展示适配

### 9.1 问题

当前"实例 × 文件"矩阵在文件夹几十上百文件时会爆炸（列数过多，表格横向溢出不可读）。

### 9.2 方案：两段式聚合视图

```
┌─ 实例A（1号线）   [████████░░] 8/12 文件   ✕失败1个  ▸展开
│   └─ config.json ✓ 12ms     sub/a.json ✕(超时)     index.html ✓ 23ms  ...
├─ 实例B（1号线）   [████████████] 12/12 文件         ✓全部成功
└─ 实例C（核心机房） [██░░░░░░░░░░] 2/12 文件
```

- 默认折叠，显示**实例级聚合**：完成数/总数 + 失败计数 + 总体进度条。
- 点击展开看单文件明细（复用现有 `progress` 数据，无需后端改动）。
- 文件数 ≤ 阈值（如 ≤ 8）时可保留矩阵视图作为可选；MVP 阶段直接统一用聚合视图，降低复杂度。

### 9.3 聚合计算

```ts
// app/composables/useDispatch.ts
function getInstanceProgress(instanceId: string, files: StoredFile[]) {
  let completed = 0, failed = 0
  for (const f of files) {
    const cell = progress.value[cellKey(instanceId, f.objectKey)]
    if (cell && cell !== 'running') {
      completed++
      if (cell.status === 'failed') failed++
    }
  }
  return { completed, total: files.length, failed }
}
```

---

## 十、配置项

新增环境变量（补充进 `docs/DEPLOY.md`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `UPLOAD_DIR` | `server/data/uploads` | 暂存目录 |
| `MAX_UPLOAD_SIZE` | `0`（不限） | 单文件最大字节数，0 表示不限 |
| `MULTIPART_THRESHOLD` | `8388608`（8MB） | 超过此大小走 multipart |
| `MULTIPART_PART_SIZE` | `5242880`（5MB） | 分片大小（S3 最小 5MB） |
| `UPLOAD_TTL_HOURS` | `24` | 孤儿暂存清理时长 |

保留现有：`PORT`、`DISPATCH_CONCURRENCY`、`DATA_FILE_PATH`。

### Nitro body limit

Nitro 默认对 JSON body 有大小限制。上传走 `multipart/form-data`，由 `readMultipartFormData` 流式解析，但保险起见在 `nuxt.config.ts` 显式放开上传路由的 body 限制：

```ts
// nuxt.config.ts（新增）
nitro: {
  routeRules: {
    '/api/uploads': {
      // multipart 由 readMultipartFormData 流式处理，放宽 body 限制
    },
  },
}
```

> 实施时需实测确认大文件上传不被截断。若 Nitro 仍有限制，改用 `event.request.formData()`（Web 标准，Bun 原生流式）替代 `readMultipartFormData`。

---

## 十一、关键技术风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| multipart `CompleteMultipartUpload` 的 body 需计算 sha256 | 完成 upload 失败 | body 用 `sha256Hex(completeBody)` 而非 `UNSIGNED-PAYLOAD`（已在设计中处理） |
| 分片上传中途失败，MinIO 侧残留 upload | 占用 MinIO 存储 | `catch` 中调 `abortMultipartUpload` 清理（已设计） |
| 暂存磁盘占满 | 无法上传 | `MAX_UPLOAD_SIZE` + cleanup 定时清理 + 分发后保留 TTL 再删 |
| 同名 objectKey 冲突 | 后传覆盖先传（MinIO 默认覆盖） | MVP 接受覆盖语义（与现状一致）；未来版本才做"覆盖前备份" |
| ETag 带/不带引号 | 完成 upload 时 ETag 格式不符 | 上传 part 后统一 `.replace(/"/g, '')` 去引号 |
| `readMultipartFormData` 对大文件全进内存 | OOM | 优先用 `event.request.formData()`（Bun 原生流式）；实施时实测 |
| Nginx 反向代理的 `client_max_body_size` | 大文件被拒 | DEPLOY.md 补充 Nginx 配置说明 |

---

## 十二、UI 布局设计

本阶段**不动整体布局**（侧边栏导航 / 顶部导航 / 路由结构全部保留）。改动集中在分发页 `/ops/dispatch` 的内部结构。

### 12.1 整体布局（不变）

```
┌─────────────────────────────────────────────┐
│  NuxtNavbar: [miniops]  MinIO批量运维平台  [暗色] │
├──────────┬──────────────────────────────────┤
│ 总览    │                                  │
│ 实例    │          主内容区                 │
│ 运维 ▸  │                                  │
│  文件分发│                                  │
└──────────┴──────────────────────────────────┘
```

理由：文件分发能力扩展不改变"这是个批量运维工具"的产品定位，不新增一级菜单。未来加"对象浏览 / 版本比对"等能力时才扩展导航。

### 12.2 分发页内部布局（扩展后）

```
┌─ 文件分发 ─────────────────────────────────────┐
│ 标题 + 描述（文案改为"将文件/文件夹批量分发…"）     │
├─ ① 选择文件 ──────────────────────────────────┤
│ [📁 添加文件] [📂 添加文件夹]      已就绪 0/3   │  ← 两按钮 + 汇总
│ ┌──────────────────────────────────────────┐ │
│ │ 📄 config.json     1.2 KB   ↑上传中 60%   │ │  ← 文件项：图标+大小+状态
│ │ 📄 logo.png        24 KB    ✓已就绪       │ │
│ │ 📁 sub/                                │ │
│ │   ├ a.json       800 B    ✓已就绪         │ │  ← 文件夹树形展示
│ │   └ data.csv     2 KB     ✕上传失败 [重传]│ │
│ └──────────────────────────────────────────┘ │
├─ ② 选择目标 & Bucket ────────────────────────┤
│ ▸ 1号线  [☑] 3个启用    [批量bucket▾]          │  ← 与 MVP 一致
│   ☑ 人民广场站  endpoint  bucket▾            │
│   ☐ 南京东路站  endpoint  bucket▾            │
├─ 目标前缀（可选）──────────────────────────────┤  ← 新增
│ [prefix/]  例: config/2025Q3/                  │
├──────────────────────────────────────────────┤
│ 已选 2 实例, 3 文件              [开始分发]    │
├─ 分发进度（聚合视图）─────────────────────────┤
│ ▷ 人民广场站  [████░░] 2/3   ✕失败1  ▸展开     │  ← 实例级折叠
│ ▷ 南京东路站  [███░░░] 1/3   进行中            │
│   ▸ 展开后：单文件 ✓/✕/⟳ 明细                  │
└──────────────────────────────────────────────┘
```

### 12.3 四个变化点

**① 文件选择区 —— 两按钮 + 异步上传态**
- 拆成"添加文件"和"添加文件夹"两个按钮（浏览器对 `webkitdirectory` 和普通 `multiple` 是两套交互）
- 去掉 `accept=".json"`，不再限制类型
- 每个文件项加 MIME 图标（按 contentType 选 `i-lucide-file-json` / `file-image` / `file-archive` / `file-text` / `file`）和大小标识；文件夹上传时树形展示相对路径
- 每个文件有独立上传状态：上传中（进度环）/ 就绪 / 失败（可重传）
- 汇总"已就绪 N/M"提示还有几份没传完，避免未上传完就点"开始分发"

**② 目标区 —— 基本不变**
- 分组 checkbox 联动、bucket 交集候选、实例级 bucket 选择器全部保留（MVP 已打磨好用）

**③ 新增"目标前缀"输入框**
- 放在目标区下方、提交栏上方，独立卡片，**可选**
- 文件夹分发最常用（如把整个 `dist/` 放到 `config/v2/` 下），单文件也通用
- 留空则上传到 bucket 根

**④ 进度展示 —— 从矩阵改为聚合视图**
- MVP 的"实例×文件"矩阵在文件夹场景列数爆炸不可读
- 改为**实例为行、默认折叠**：每行显示 `[完成数/总数] + 失败计数 + 进度条`，点击 `▸` 展开看单文件明细
- 适合"运维扫一眼"——一眼看出哪个实例没推全，再展开定位具体文件

