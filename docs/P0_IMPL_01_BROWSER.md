# 提议 1 实施计划：对象浏览器（Object Browser）

> **目标**：在 miniops 平台内实现 MinIO 对象浏览能力，包括列出对象、前缀导航、下载（后端流式代理）、删除（单个 + 批量）。
>
> 配套交互设计文档：`P0_DESIGN_01_BROWSER.md`

---

## 一、现状分析

### 1.1 现有可复用能力

```
server/utils/minio.ts
  ├ signRequest()          ← 通用 SigV4 Authorization 头签名，支持任意 method/query/payloadHash
  ├ presignPutUrl()        ← 预签名 PUT URL（可改造为 GET）
  ├ listBuckets()          ← ListBuckets API，已有 XML 正则解析
  ├ uploadObject()         ← 统一上传入口（小文件单次 PUT + 大文件 multipart）
  ├ extractXmlTag()        ← 从 XML 提取单个标签
  ├ parseBucketNames()     ← 从 ListBuckets XML 提取 bucket 名
  └ inferContentType()     ← 根据扩展名推断 MIME

server/utils/store.ts
  └ getGroups()            ← 获取所有实例组（含嵌套实例）

server/api/instances/buckets.post.ts
  └ 批量获取 bucket 列表（传 instanceIds[]）← 查实例的模式可复用
```

### 1.2 现有签名函数能力边界

`signRequest()` 是通用的，当前签名只用 `host` + `x-amz-content-sha256` 两个 signedHeaders。对于对象浏览需要的 ListObjectsV2 / DeleteMultipleObjects / GetObject，签名逻辑完全够用：

| S3 操作 | method | path | query | payloadHash | 现有 signRequest 是否够用 |
|---|---|---|---|---|---|
| ListObjectsV2 | GET | `/{bucket}` | `list-type=2&prefix=...&delimiter=...&continuation-token=...` | 空 sha256 | ✅ |
| DeleteMultipleObjects | POST | `/{bucket}?delete` | `delete=` | body 的 sha256 | ✅ |
| GetObject | GET | `/{bucket}/{key}` | 空 | 空 sha256 | ✅ |

**结论：零新增签名代码**，所有操作复用 `signRequest()` 和 `presignPutUrl()`（后者改造为支持 GET）。

### 1.3 现有前端结构

```
app/
  ├ components/AppLayout.vue          ← 侧边栏导航（需新增"对象浏览"项）
  ├ components/ConfirmDialog.vue      ← 二次确认弹窗（删除时复用）
  ├ pages/ops/dispatch/index.vue      ← 分发页（三步线性流参考）
  ├ pages/groups/index.vue            ← 实例管理页（需新增"浏览"快捷按钮）
  └ composables/useDispatch.ts        ← 分发逻辑（不涉及）
```

### 1.4 缺失能力

- `listObjects()`：ListObjectsV2 调用 + XML 解析（`<Contents>` + `<CommonPrefixes>`）
- `deleteObjects()`：DeleteMultipleObjects 调用
- `deleteByPrefixes()`：递归列出前缀下所有对象并批量删除（递归删除文件夹）
- `presignGetUrl()`：预签名 GET URL（复用 `presignPutUrl` 逻辑改 method）
- `getObjectStream()`：GetObject 返回流式响应
- 3 条 API 路由（delete 路由支持 `prefixes` 参数）
- 1 个前端页面
- 导航 + 实例管理页快捷入口

---

## 二、改动清单

### 2.1 后端

| 文件 | 操作 | 说明 |
|---|---|---|
| `server/utils/minio.ts` | 修改 | 新增 `listObjects()` / `deleteObjects()` / `deleteByPrefixes()` / `presignGetUrl()` / `getObjectStream()`；`presignPutUrl` 重构为通用 `presignUrl`（支持 method 参数）；新增 XML 解析辅助 |
| `server/types/index.ts` | 修改 | 新增 `ObjectInfo` / `ListObjectsResult` / `DeleteObjectsResult` 类型 |
| `server/api/instances/objects/list.post.ts` | 新增 | 列出对象 |
| `server/api/instances/objects/delete.post.ts` | 新增 | 删除对象（支持 prefixes 递归删除） |
| `server/api/instances/objects/download.get.ts` | 新增 | 下载代理（流式，支持 Range） |
| `server/api/instances/objects/download-batch.post.ts` | 新增 | 批量 ZIP 打包下载（流式 archiver） |
| `server/api/instances/objects/presign.post.ts` | 新增 | 生成预签名 GET URL |

### 2.2 前端

| 文件 | 操作 | 说明 |
|---|---|---|
| `app/components/AppLayout.vue` | 修改 | navItems「运维」下新增「对象浏览」 |
| `app/pages/ops/browser/index.vue` | 新增 | 对象浏览器页面 |
| `app/pages/groups/index.vue` | 修改 | 实例行新增「浏览」快捷按钮 |

**总计：后端 2 改 5 新，前端 2 改 1 新。新增依赖：`archiver`。**

---

## 三、详细实现

### 3.1 类型定义（`server/types/index.ts`）

在文件末尾新增：

```typescript
// ---------- 对象浏览相关类型 ----------

/** 单个对象信息（ListObjectsV2 的 <Contents> 项） */
export interface ObjectInfo {
  /** 对象完整 Key，如 "config/2025Q3/device.json" */
  key: string
  /** 文件大小（字节） */
  size: number
  /** 最后修改时间（ISO 字符串） */
  lastModified: string
  /** Content-Type（从 ETag/StorageClass 等字段推断，可能为空） */
  contentType?: string
  /** ETag（可用作版本标识） */
  etag?: string
}

/** ListObjectsV2 结果 */
export interface ListObjectsResult {
  /** 对象列表（<Contents>） */
  objects: ObjectInfo[]
  /** 公共前缀列表（<CommonPrefixes>，虚拟文件夹） */
  commonPrefixes: string[]
  /** 是否已截断（还有更多未返回） */
  isTruncated: boolean
  /** 下一页的 continuationToken */
  continuationToken?: string
  /** 错误信息 */
  error?: string
}

/** 删除对象结果 */
export interface DeleteObjectsResult {
  /** 已成功删除的 key 列表 */
  deleted: string[]
  /** 删除失败的项 */
  errors: { key: string, error: string }[]
}
```

### 3.2 后端 minio.ts 新增函数

#### 3.2.1 presignUrl（重构 presignPutUrl）

将现有 `presignPutUrl` 重构为通用 `presignUrl`，支持指定 method：

```typescript
/**
 * 生成 AWS SigV4 预签名 URL（支持任意 method）。
 * 不依赖任何 SDK，纯 Node crypto 实现。
 */
function presignUrl(opts: {
  method: string            // 'GET' | 'PUT'
  endpoint: string
  bucket: string
  objectKey: string
  accessKey: string
  secretKey: string
  region: string
  expiresIn: number
}): string {
  // 与现有 presignPutUrl 逻辑完全一致
  // 唯一区别：canonicalRequest 第一行从硬编码 'PUT' 改为 opts.method
  ...
}

/** 预签名 PUT URL（保持向后兼容） */
function presignPutUrl(opts: { ... }): string {
  return presignUrl({ ...opts, method: 'PUT' })
}

/** 预签名 GET URL（下载用） */
export function presignGetUrl(opts: {
  endpoint: string
  bucket: string
  objectKey: string
  accessKey: string
  secretKey: string
  region: string
  expiresIn: number
}): string {
  return presignUrl({ ...opts, method: 'GET' })
}
```

#### 3.2.2 listObjects（ListObjectsV2）

```typescript
/**
 * 列出 bucket 下指定前缀的对象和子前缀（虚拟文件夹）。
 *
 * 调用 S3 ListObjectsV2 API (GET /{bucket}?list-type=2&prefix=&delimiter=/)。
 * 用 signRequest 签名，解析 XML 的 <Contents> 和 <CommonPrefixes>。
 */
export async function listObjects(
  instance: MinioInstance,
  bucket: string,
  prefix: string,
  delimiter: string,
  continuationToken?: string,
): Promise<ListObjectsResult> {
  const endpoint = instance.endpoint.replace(/\/+$/, '')
  const host = new URL(endpoint).host
  const path = `/${bucket}`

  // 构建 query string（key 需按字母序，用于签名）
  const queryParams: [string, string][] = [
    ['list-type', '2'],
    ['prefix', prefix],
    ['delimiter', delimiter],
    ['max-keys', '1000'],
  ]
  if (continuationToken) {
    queryParams.push(['continuation-token', continuationToken])
  }
  queryParams.sort(([a], [b]) => a.localeCompare(b))

  // 签名用的 canonical query string（值需 URI 编码）
  const queryString = queryParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const payloadHash = createHash('sha256').update('').digest('hex')
  const { authorization, amzDate } = signRequest({
    method: 'GET',
    endpoint,
    path,
    queryString,
    accessKey: instance.accessKey,
    secretKey: instance.secretKey,
    region: 'us-east-1',
    payloadHash,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)  // 大 bucket 可能较慢

  try {
    const res = await fetch(`${endpoint}${path}?${queryString}`, {
      method: 'GET',
      headers: {
        'Host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Authorization': authorization,
      },
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        objects: [],
        commonPrefixes: [],
        isTruncated: false,
        error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      }
    }

    const xml = await res.text()
    return parseListObjectsXml(xml)
  }
  catch (e: any) {
    clearTimeout(timer)
    const err = e?.name === 'AbortError' ? '请求超时（30s）' : (e?.cause?.code || e?.message || '连接失败')
    return {
      objects: [],
      commonPrefixes: [],
      isTruncated: false,
      error: err,
    }
  }
}
```

#### 3.2.3 parseListObjectsXml（XML 解析）

```typescript
/**
 * 解析 ListObjectsV2 的 XML 响应。
 *
 * 关键字段：
 * - <Contents><Key>...</Key><Size>...</Size><LastModified>...</LastModified><ETag>...</ETag></Contents>
 * - <CommonPrefixes><Prefix>...</Prefix></CommonPrefixes>
 * - <IsTruncated>true|false</IsTruncated>
 * - <NextContinuationToken>...</NextContinuationToken>
 */
function parseListObjectsXml(xml: string): ListObjectsResult {
  const objects: ObjectInfo[] = []
  const commonPrefixes: string[] = []

  // 提取所有 <Contents>...</Contents> 块
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g
  let match: RegExpExecArray | null
  while ((match = contentsRegex.exec(xml)) !== null) {
    const block = match[1]
    const key = extractXmlTag(block, 'Key')
    const sizeStr = extractXmlTag(block, 'Size')
    const lastModified = extractXmlTag(block, 'LastModified')
    const etag = extractXmlTag(block, 'ETag')
    if (key) {
      objects.push({
        key,
        size: sizeStr ? parseInt(sizeStr, 10) : 0,
        lastModified: lastModified || '',
        etag: etag?.replace(/"/g, ''),
      })
    }
  }

  // 提取所有 <CommonPrefixes><Prefix>...</Prefix></CommonPrefixes>
  const prefixRegex = /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>/g
  while ((match = prefixRegex.exec(xml)) !== null) {
    if (match[1]) commonPrefixes.push(match[1])
  }

  const isTruncated = extractXmlTag(xml, 'IsTruncated') === 'true'
  const continuationToken = extractXmlTag(xml, 'NextContinuationToken') ?? undefined

  return { objects, commonPrefixes, isTruncated, continuationToken }
}
```

#### 3.2.4 deleteObjects（DeleteMultipleObjects）

```typescript
/**
 * 批量删除对象（S3 DeleteMultipleObjects API）。
 *
 * POST /{bucket}?delete，body 为 XML，包含要删除的 <Object><Key>...</Key></Object> 列表。
 * 一次最多 1000 个。
 */
export async function deleteObjects(
  instance: MinioInstance,
  bucket: string,
  keys: string[],
): Promise<DeleteObjectsResult> {
  if (keys.length === 0) {
    return { deleted: [], errors: [] }
  }
  if (keys.length > 1000) {
    return { deleted: [], errors: [{ key: '', error: '一次最多删除 1000 个对象' }] }
  }

  const endpoint = instance.endpoint.replace(/\/+$/, '')
  const host = new URL(endpoint).host
  const path = `/${bucket}`
  const queryString = 'delete='

  // 构造 XML body
  const body = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Delete>` +
    keys.map(k => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('') +
    `<Quiet>false</Quiet>` +
    `</Delete>`

  const payloadHash = sha256Hex(body)
  const { authorization, amzDate } = signRequest({
    method: 'POST',
    endpoint,
    path,
    queryString,
    accessKey: instance.accessKey,
    secretKey: instance.secretKey,
    region: 'us-east-1',
    payloadHash,
  })

  // 注意：delete 的 query 签名是 'delete='（含等号）
  // canonical query string 需为 'delete='（值空）
  // 但 signRequest 的 queryString 参数用于 canonical request，需保持 'delete='

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)

  try {
    const res = await fetch(`${endpoint}${path}?delete`, {
      method: 'POST',
      body,
      headers: {
        'Host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Authorization': authorization,
        'Content-Type': 'application/xml',
        'Content-MD5': createHash('md5').update(body).digest('base64'),
      },
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return {
        deleted: [],
        errors: keys.map(k => ({ key: k, error: `HTTP ${res.status}: ${errBody.slice(0, 200)}` })),
      }
    }

    const xml = await res.text()
    return parseDeleteResultXml(xml, keys)
  }
  catch (e: any) {
    clearTimeout(timer)
    const err = e?.name === 'AbortError' ? '请求超时（30s）' : (e?.cause?.code || e?.message || '连接失败')
    return { deleted: [], errors: keys.map(k => ({ key: k, error: err })) }
  }
}

/** XML 特殊字符转义 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 解析 DeleteMultipleObjects 响应。
 *
 * <DeleteResult>
 *   <Deleted><Key>...</Key></Deleted>
 *   <Error><Key>...</Key><Code>...</Code><Message>...</Message></Error>
 * </DeleteResult>
 */
function parseDeleteResultXml(xml: string, requestedKeys: string[]): DeleteObjectsResult {
  const deleted: string[] = []
  const errors: { key: string, error: string }[] = []

  // 已删除
  const deletedRegex = /<Deleted>\s*<Key>([^<]+)<\/Key>/g
  let match: RegExpExecArray | null
  while ((match = deletedRegex.exec(xml)) !== null) {
    if (match[1]) deleted.push(match[1])
  }

  // 失败
  const errorRegex = /<Error>([\s\S]*?)<\/Error>/g
  while ((match = errorRegex.exec(xml)) !== null) {
    const block = match[1]
    const key = extractXmlTag(block, 'Key')
    const code = extractXmlTag(block, 'Code')
    const message = extractXmlTag(block, 'Message')
    if (key) {
      errors.push({ key, error: `${code || 'Error'}: ${message || ''}` })
    }
  }

  // 约定：响应中既不在 <Deleted> 也不在 <Error> 的 key，视为删除成功（兜底）
  const accounted = new Set([...deleted, ...errors.map(e => e.key)])
  for (const k of requestedKeys) {
    if (!accounted.has(k)) deleted.push(k)
  }

  return { deleted, errors }
}
```

#### 3.2.4b deleteByPrefixes（递归删除文件夹）

```typescript
/** 递归删除的安全上限，防止误删超大规模文件夹导致长时间阻塞 */
const RECURSIVE_DELETE_LIMIT = 10000

/**
 * 递归删除指定前缀下的所有对象。
 *
 * 先用 listObjects（delimiter="" 递归列出）分页收集全部 key，
 * 再分批调 deleteObjects（每批 1000 个）。
 *
 * @param prefixes 文件夹前缀列表，如 ["sub-folder/", "backup/2024/"]
 */
export async function deleteByPrefixes(
  instance: MinioInstance,
  bucket: string,
  prefixes: string[],
): Promise<DeleteObjectsResult> {
  const allDeleted: string[] = []
  const allErrors: { key: string, error: string }[] = []

  for (const prefix of prefixes) {
    // 递归列出该前缀下所有对象（delimiter="" 不分组虚拟文件夹）
    const keys: string[] = []
    let token: string | undefined
    do {
      const result = await listObjects(instance, bucket, prefix, '', token)
      if (result.error) {
        allErrors.push({ key: prefix, error: `列出对象失败: ${result.error}` })
        break
      }
      keys.push(...result.objects.map(o => o.key))
      token = result.isTruncated ? result.continuationToken : undefined

      // 安全上限
      if (keys.length > RECURSIVE_DELETE_LIMIT) {
        allErrors.push({ key: prefix, error: `文件夹下对象过多（>${RECURSIVE_DELETE_LIMIT}），请缩小范围后重试` })
        break
      }
    } while (token)

    // 跳过因超限而中断的前缀
    const prefixErrors = allErrors.filter(e => e.key === prefix)
    if (prefixErrors.length) continue

    // 分批删除（每批 1000 个）
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000)
      const result = await deleteObjects(instance, bucket, batch)
      allDeleted.push(...result.deleted)
      allErrors.push(...result.errors)
    }
  }

  return { deleted: allDeleted, errors: allErrors }
}
```

#### 3.2.5 getObjectStream（下载代理）

```typescript
/**
 * 获取对象内容流（S3 GetObject）。
 *
 * 返回 fetch 的 Response，调用方从 res.body 读取 ReadableStream 转发。
 * 不缓冲整个文件到内存，支持大文件流式下载。
 */
export async function getObjectStream(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
): Promise<{ response: Response | null, error?: string }> {
  const endpoint = instance.endpoint.replace(/\/+$/, '')
  const host = new URL(endpoint).host
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
  const path = `/${bucket}/${encodedKey}`
  const queryString = ''
  const payloadHash = createHash('sha256').update('').digest('hex')

  const { authorization, amzDate } = signRequest({
    method: 'GET',
    endpoint,
    path,
    queryString,
    accessKey: instance.accessKey,
    secretKey: instance.secretKey,
    region: 'us-east-1',
    payloadHash,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 600000) // 大文件下载 10 分钟超时

  try {
    const res = await fetch(`${endpoint}${path}`, {
      method: 'GET',
      headers: {
        'Host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Authorization': authorization,
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      clearTimeout(timer)
      return { response: null, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
    }

    // 注意：不调 clearTimeout，让流读取完后自然释放
    // 调用方负责消费 res.body
    return { response: res }
  }
  catch (e: any) {
    clearTimeout(timer)
    const err = e?.name === 'AbortError' ? '请求超时' : (e?.cause?.code || e?.message || '连接失败')
    return { response: null, error: err }
  }
}
```

### 3.3 API 路由

#### 3.3.1 list.post.ts

```typescript
// server/api/instances/objects/list.post.ts
import { getGroups } from '../../../utils/store'
import { listObjects } from '../../../utils/minio'
import type { MinioInstance } from '../../../types'

/**
 * POST /api/instances/objects/list
 * 列出指定实例 bucket 下的对象和公共前缀。
 *
 * 请求体: { instanceId, bucket, prefix?, delimiter?, continuationToken? }
 * 响应: ListObjectsResult
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    prefix?: string
    delimiter?: string
    continuationToken?: string
  }>(event)

  if (!body?.instanceId) throw createError({ statusCode: 400, statusMessage: '缺少 instanceId' })
  if (!body?.bucket) throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })

  // 从 store 查出实例
  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find(i => i.id === body.instanceId)
    if (instance) break
  }
  if (!instance) throw createError({ statusCode: 404, statusMessage: '未找到指定实例' })

  const result = await listObjects(
    instance,
    body.bucket,
    body.prefix ?? '',
    body.delimiter ?? '/',
    body.continuationToken,
  )

  if (result.error) {
    throw createError({ statusCode: 502, statusMessage: result.error })
  }
  return result
})
```

#### 3.3.2 delete.post.ts

```typescript
// server/api/instances/objects/delete.post.ts
import { getGroups } from '../../../utils/store'
import { deleteObjects, deleteByPrefixes } from '../../../utils/minio'
import type { MinioInstance } from '../../../types'

/**
 * POST /api/instances/objects/delete
 * 批量删除对象，支持递归删除文件夹。
 *
 * 请求体: { instanceId, bucket, keys: string[], prefixes?: string[] }
 *   - keys:     要删除的对象 key 列表
 *   - prefixes: 要递归删除的文件夹前缀列表（如 ["sub-folder/"]）
 *
 * 响应: DeleteObjectsResult
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    keys: string[]
    prefixes?: string[]
  }>(event)

  if (!body?.instanceId) throw createError({ statusCode: 400, statusMessage: '缺少 instanceId' })
  if (!body?.bucket) throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  if (!body?.keys?.length && !body?.prefixes?.length) throw createError({ statusCode: 400, statusMessage: '缺少 keys 或 prefixes' })

  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find(i => i.id === body.instanceId)
    if (instance) break
  }
  if (!instance) throw createError({ statusCode: 404, statusMessage: '未找到指定实例' })

  // 合并结果
  let allDeleted: string[] = []
  let allErrors: { key: string, error: string }[] = []

  // 1. 删除普通对象
  if (body.keys?.length) {
    const result = await deleteObjects(instance, body.bucket, body.keys)
    allDeleted.push(...result.deleted)
    allErrors.push(...result.errors)
  }

  // 2. 递归删除文件夹
  if (body.prefixes?.length) {
    const result = await deleteByPrefixes(instance, body.bucket, body.prefixes)
    allDeleted.push(...result.deleted)
    allErrors.push(...result.errors)
  }

  if (allErrors.length && allDeleted.length === 0) {
    throw createError({ statusCode: 502, statusMessage: allErrors[0]?.error || '删除失败' })
  }
  return { deleted: allDeleted, errors: allErrors }
})
```

#### 3.3.3 download.get.ts

```typescript
// server/api/instances/objects/download.get.ts
import { getGroups } from '../../../utils/store'
import { getObjectStream } from '../../../utils/minio'
import type { MinioInstance } from '../../../types'

/**
 * GET /api/instances/objects/download?instanceId=&bucket=&key=
 * 流式下载对象，后端代理转发。
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const instanceId = query.instanceId as string
  const bucket = query.bucket as string
  const key = query.key as string

  if (!instanceId) throw createError({ statusCode: 400, statusMessage: '缺少 instanceId' })
  if (!bucket) throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  if (!key) throw createError({ statusCode: 400, statusMessage: '缺少 key' })

  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find(i => i.id === instanceId)
    if (instance) break
  }
  if (!instance) throw createError({ statusCode: 404, statusMessage: '未找到指定实例' })

  const { response, error } = await getObjectStream(instance, bucket, key)
  if (error || !response) {
    throw createError({ statusCode: 502, statusMessage: error || '下载失败' })
  }

  // 透传响应头
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const contentLength = response.headers.get('content-length')
  const lastModified = response.headers.get('last-modified')

  // 文件名取 key 最后一段
  const filename = key.split('/').pop() || 'download'
  setResponseHeader(event, 'Content-Type', contentType)
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
  if (contentLength) setResponseHeader(event, 'Content-Length', contentLength)
  if (lastModified) setResponseHeader(event, 'Last-Modified', lastModified)

  return sendStream(event, response.body!)
})
```

#### 3.3.4 presign.post.ts

```typescript
// server/api/instances/objects/presign.post.ts
import { getGroups } from '../../../utils/store'
import { presignGetUrl } from '../../../utils/minio'
import type { MinioInstance } from '../../../types'

/**
 * POST /api/instances/objects/presign
 * 生成预签名 GET URL（下载用）。
 *
 * 请求体: { instanceId, bucket, key, expiresIn? }
 * 响应: { url: string }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    key: string
    expiresIn?: number
  }>(event)

  if (!body?.instanceId) throw createError({ statusCode: 400, statusMessage: '缺少 instanceId' })
  if (!body?.bucket) throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  if (!body?.key) throw createError({ statusCode: 400, statusMessage: '缺少 key' })

  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find(i => i.id === body.instanceId)
    if (instance) break
  }
  if (!instance) throw createError({ statusCode: 404, statusMessage: '未找到指定实例' })

  const url = presignGetUrl({
    endpoint: instance.endpoint,
    bucket: body.bucket,
    objectKey: body.key,
    accessKey: instance.accessKey,
    secretKey: instance.secretKey,
    region: 'us-east-1',
    expiresIn: body.expiresIn ?? 900, // 默认 15 分钟
  })

  return { url }
})
```

#### 3.3.5 download-batch.post.ts（批量 ZIP 打包下载）

```typescript
// server/api/instances/objects/download-batch.post.ts
import { getGroups } from '../../../utils/store'
import { listObjects, getObjectStream } from '../../../utils/minio'
import archiver from 'archiver'
import type { MinioInstance } from '../../../types'

/** 批量 ZIP 打包的对象数量上限 */
const BATCH_DOWNLOAD_COUNT_LIMIT = 1000
/** 批量 ZIP 打包的总大小上限（500MB） */
const BATCH_DOWNLOAD_SIZE_LIMIT = 500 * 1024 * 1024

/**
 * POST /api/instances/objects/download-batch
 * 批量 ZIP 打包下载，支持混合选中对象和文件夹。
 *
 * 请求体: { instanceId, bucket, keys: string[], prefixes?: string[] }
 * 响应: application/zip 流式下载
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    keys: string[]
    prefixes?: string[]
  }>(event)

  if (!body?.instanceId) throw createError({ statusCode: 400, statusMessage: '缺少 instanceId' })
  if (!body?.bucket) throw createError({ statusCode: 400, statusMessage: '缺少 bucket' })
  if (!body?.keys?.length && !body?.prefixes?.length) throw createError({ statusCode: 400, statusMessage: '缺少 keys 或 prefixes' })

  // 从 store 查出实例
  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find(i => i.id === body.instanceId)
    if (instance) break
  }
  if (!instance) throw createError({ statusCode: 404, statusMessage: '未找到指定实例' })

  // 1. 收集所有要打包的对象 key（keys + 递归列出 prefixes，去重）
  const allKeys = new Set<string>(body.keys ?? [])

  for (const prefix of body.prefixes ?? []) {
    let token: string | undefined
    do {
      const result = await listObjects(instance, body.bucket, prefix, '', token)
      if (result.error) {
        throw createError({ statusCode: 502, statusMessage: `列出文件夹失败: ${result.error}` })
      }
      for (const o of result.objects) {
        allKeys.add(o.key)
      }
      token = result.isTruncated ? result.continuationToken : undefined
    } while (token)
  }

  // 2. 检查数量上限
  if (allKeys.size > BATCH_DOWNLOAD_COUNT_LIMIT) {
    throw createError({
      statusCode: 400,
      statusMessage: `选中内容过多（${allKeys.size} 个对象 > ${BATCH_DOWNLOAD_COUNT_LIMIT}），请缩小范围`,
    })
  }

  // 3. 创建 ZIP 流
  const archive = archiver('zip', { zlib: { level: 1 } }) // level 1 快速压缩
  const zipName = `miniops-download-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`

  setResponseHeader(event, 'Content-Type', 'application/zip')
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${zipName}"`)

  // pipe archiver 到 HTTP 响应
  archive.pipe(event.node.res)

  // 4. 逐个 GetObject -> append 到 ZIP
  const timer = setTimeout(() => archive.abort(), 300000) // 5 分钟超时

  try {
    for (const key of allKeys) {
      const { response, error } = await getObjectStream(instance, body.bucket, key)
      if (error || !response) {
        // 跳过失败的对象，在 zip 中添加错误标记
        archive.append(`下载失败: ${error}\n`, { name: `${key}.ERROR.txt` })
        continue
      }
      // ZIP 内路径用对象 key（保持目录结构）
      archive.append(response.body!, { name: key })
    }

    // 5. 完成 ZIP
    await archive.finalize()
  }
  catch (e: any) {
    throw createError({ statusCode: 502, statusMessage: e?.message || '打包失败' })
  }
  finally {
    clearTimeout(timer)
  }
})
```

**关键实现细节：**

- **archiver 流式管道**：`archive.pipe(event.node.res)` 将 ZIP 数据流式写入 HTTP 响应，不缓冲整个 zip 到内存
- **对象流直接 append**：`archive.append(response.body!, { name: key })` 将 GetObject 的 ReadableStream 直接作为 zip 条目，archiver 内部流式读取
- **压缩级别**：`zlib.level: 1`（快速压缩，运维场景多为配置文件/日志，压缩比不重要，速度优先）
- **失败容错**：单个对象获取失败时跳过，在 zip 中添加 `.ERROR.txt` 标记，不中断整个打包
- **无 Content-Length**：ZIP 流式打包无法预知最终大小，浏览器显示"未知大小"但下载正常
- **超时**：5 分钟（300000ms），覆盖中等目录的打包时间

### 3.4 前端页面（`app/pages/ops/browser/index.vue`）

#### 3.4.1 页面结构

```vue
<script setup lang="ts">
// 1. 状态：实例列表、选中实例、bucket 列表、选中 bucket
// 2. 状态：对象列表、commonPrefixes、continuationToken、当前前缀、面包屑
// 3. 状态：多选集合、loading 标志、删除确认弹窗
// 4. URL 参数同步（instanceId / bucket / prefix）

// 类型定义（与后端对齐）
interface ObjectInfo { key, size, lastModified, etag?, contentType? }
interface ListObjectsResult { objects, commonPrefixes, isTruncated, continuationToken? }

// 核心方法
loadInstances()       // GET /api/groups -> 展开实例
onInstanceChange()    // 加载 bucket 列表
onBucketChange()      // 加载根前缀对象列表
loadObjects(prefix, token?)  // POST /api/instances/objects/list
navigateToPrefix(p)   // 进入子前缀
navigateToBreadcrumb(index)  // 面包屑回退
jumpToPrefix()        // 前缀输入框跳转
loadMore()            // 加载更多
refresh()             // 刷新当前页
downloadObject(key)   // 触发下载
copyPresignUrl(key)   // 复制预签名 URL
deleteSingle(key)     // 单个删除
deleteSelected()      // 批量删除
confirmDelete()       // 执行删除
</script>
```

#### 3.4.2 关键交互实现

**URL 状态同步**：

```typescript
const route = useRoute()
const router = useRouter()

// 读取 URL 初始化
const initialInstanceId = route.query.instanceId as string
const initialBucket = route.query.bucket as string
const initialPrefix = route.query.prefix as string

// 状态变化时更新 URL
watch([selectedInstanceId, selectedBucket, currentPrefix], () => {
  router.replace({
    query: {
      instanceId: selectedInstanceId.value || undefined,
      bucket: selectedBucket.value || undefined,
      prefix: currentPrefix.value || undefined,
    },
  })
})
```

**面包屑数据**：

```typescript
// 当前前缀拆成层级数组
const breadcrumbs = computed(() => {
  const p = currentPrefix.value
  if (!p) return [{ label: '根', prefix: '' }]
  const segments = p.replace(/\/$/, '').split('/').filter(Boolean)
  const crumbs = [{ label: '根', prefix: '' }]
  let acc = ''
  for (const seg of segments) {
    acc += `${seg}/`
    crumbs.push({ label: `${seg}/`, prefix: acc })
  }
  return crumbs
})
```

**文件大小格式化**：

```typescript
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
```

**时间格式化**：

```typescript
function formatDate(iso: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}
```

**对象名显示**（去掉当前前缀）：

```typescript
function displayName(key: string): string {
  const prefix = currentPrefix.value
  const stripped = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key
  return stripped.split('/').pop() || key
}
```

### 3.5 导航与快捷入口

#### 3.5.1 AppLayout.vue

```typescript
// navItems 的「运维」children 新增
{
  label: '运维',
  icon: 'i-lucide-wrench',
  defaultOpen: true,
  children: [
    { label: '文件分发', to: '/ops/dispatch', icon: 'i-lucide-send' },
    { label: '对象浏览', to: '/ops/browser', icon: 'i-lucide-folder-search' },  // 新增
  ],
}
```

#### 3.5.2 groups/index.vue 实例行快捷入口

在每个启用实例行的操作按钮区新增"浏览"按钮：

```html
<NuxtButton
  size="xs"
  color="info"
  variant="soft"
  icon="i-lucide-folder-search"
  :to="`/ops/browser?instanceId=${inst.id}`"
>
  浏览
</NuxtButton>
```

---

## 四、实施步骤

按以下顺序执行，每步可独立验证：

| 步骤 | 内容 | 验证方式 |
|---|---|---|
| 1 | `server/types/index.ts` 新增 `ObjectInfo` / `ListObjectsResult` / `DeleteObjectsResult` 类型 | TypeScript 编译通过 |
| 2 | `server/utils/minio.ts` 重构 `presignPutUrl` 为通用 `presignUrl`，新增 `presignGetUrl` | 编译通过，现有上传功能不受影响 |
| 3 | `server/utils/minio.ts` 新增 `listObjects()` + `parseListObjectsXml()` | 手动 curl 调用 API 验证返回对象列表 |
| 4 | `server/utils/minio.ts` 新增 `deleteObjects()` + `parseDeleteResultXml()` + `escapeXml()` | 手动 curl 验证删除 |
| 5 | `server/utils/minio.ts` 新增 `getObjectStream()` | 手动 curl 验证下载 |
| 6 | 新增 4 条 API 路由（list / delete / download / presign） | curl 逐个测试 |
| 7 | `app/components/AppLayout.vue` 新增导航项 | 启动 dev，侧边栏出现"对象浏览" |
| 8 | `app/pages/ops/browser/index.vue` 页面骨架：选实例 + 选 bucket + 对象列表展示 | dev 页面可浏览对象 |
| 9 | 前端前缀导航：面包屑 + 前缀输入框跳转 | 点击文件夹进入、面包屑回退、输入框跳转 |
| 10 | 前端多选 + 删除（单个 + 批量）+ ConfirmDialog | 勾选删除，二次确认，刷新 |
| 11 | 前端下载（后端代理）+ 复制预签名 URL | 点击下载触发浏览器下载，复制链接可粘贴 |
| 12 | `app/pages/groups/index.vue` 新增"浏览"快捷按钮 | 实例管理页点击跳转并预选实例 |
| 13 | URL 状态同步 | 切换实例/bucket/前缀时 URL 更新，前进后退恢复 |
| 14 | 端到端测试 | dev server + 本地 MinIO 完整走通 |

---

## 五、验证矩阵

| 场景 | 预期结果 |
|---|---|
| 选实例 + 选 bucket -> 加载根对象列表 | 显示对象 + 虚拟文件夹 |
| bucket 为空 | 显示空状态 |
| 点击虚拟文件夹 | 面包屑追加一层，加载子前缀对象 |
| 点击面包屑某层 | 回退到该层，加载对象列表 |
| 前缀输入框输入路径跳转 | 面包屑更新，加载对应前缀对象 |
| 对象数 > 1000 | 显示"加载更多"按钮，点击追加 |
| 点击单个对象"下载" | 浏览器触发下载，文件名正确 |
| 点击"复制链接" | 剪贴板含预签名 URL，Toast 提示 |
| 勾选多个对象 -> 删除选中 | ConfirmDialog 显示对象列表 + 总大小 |
| 确认删除 | Toast 提示成功数，列表刷新 |
| 删除部分失败 | Toast 提示"已删除 N 个，M 个失败"，失败行标红 |
| 勾选含虚拟文件夹 -> 删除 | ConfirmDialog 标注文件夹递归删除，确认后递归删除成功 |
| 文件夹下对象 > 10000 | 拒绝删除，提示“对象过多，请缩小范围” |
| 实例不可达 | bucket 加载失败，显示错误 + 重试 |
| 凭据无效（403） | 对象列表显示"凭据无效"，无法加载 |
| URL 含 instanceId 参数 | 自动预选该实例 |
| URL 含 bucket + prefix 参数 | 自动加载到对应前缀 |
| 浏览器前进/后退 | 状态正确恢复 |
| 实例管理页点击"浏览" | 跳转到对象浏览页并预选实例 |
| 大文件下载（>1GB） | 流式下载，后端内存不爆 |
| 勾选多个对象 -> 下载选中 | 浏览器下载一个 .zip 文件，内含选中对象 |
| 勾选含文件夹 -> 下载选中 | ZIP 内保留目录结构，递归下载文件夹下所有对象 |
| 混合选中对象+文件夹 -> 下载 | ZIP 内含文件夹下全部对象 + 单独对象，去重后打包 |
| 批量下载对象 > 1000 | 拒绝打包，提示“选中内容过多，请缩小范围” |
| 批量下载中某个对象失败 | ZIP 内含 `.ERROR.txt` 标记，其余正常下载 |

---

## 六、技术风险与对策

### 6.1 ListObjectsV2 签名细节

**风险**：query string 的 URI 编码规则与签名 canonical query string 的要求需精确对齐。`continuation-token` 可能含特殊字符（`+`、`=`），编码不当会签名失败。

**对策**：
- 签名用的 canonical query string 中，key 和 value 都用 `encodeURIComponent` 编码
- 实际请求 URL 也用同一套编码
- 编码后按 key 字母序排序

### 6.2 DeleteMultipleObjects 的 Content-MD5

**风险**：S3 规范要求 DeleteMultipleObjects 请求必须带 `Content-MD5` 头（body 的 MD5 base64），否则返回 400。

**对策**：在 `deleteObjects()` 中计算 `Content-MD5: createHash('md5').update(body).digest('base64')`。

> 注：MinIO 可能不强制要求 Content-MD5（部分版本宽松），但加上更兼容 AWS S3 标准。

### 6.3 大文件下载内存控制

**风险**：`getObjectStream` 返回的 `response.body` 是 ReadableStream，如果用 `sendStream` 转发不当可能导致缓冲整个文件到内存。

**对策**：
- 使用 Nitro/H3 的 `sendStream(event, stream)`，它内部用管道流式转发，不缓冲
- 不设 `Content-Disposition: inline`（避免浏览器尝试内联渲染大文件）
- 超时设为 10 分钟（600000ms），覆盖大文件慢下载场景

### 6.4 前缀输入框路径遍历

**风险**：用户在前缀输入框输入 `../` 可能尝试路径遍历。

**对策**：
- 前端调用 `sanitizeObjectKey()` 清洗（复用 `server/utils/uploads.ts` 的逻辑，防 `..`）
- 后端 `listObjects` 也做清洗（双重保险）
- S3 本身没有路径遍历风险（前缀只是过滤条件），但清洗避免无意义的请求

### 6.5 并发删除的一致性

**风险**：用户在删除确认期间，对象可能被其他操作修改或删除。

**对策**：S3 删除是幂等的（删除已删除的对象返回成功），无需特殊处理。删除后刷新列表即可。

---

## 七、不涉及的范围

- 不实现对象上传（上传走现有分发流程）
- 不实现对象内容预览（图片/文本/视频预览留作后续增强）  
  > 注：已实现预览功能，见 `P0_DESIGN_01B_PREVIEW.md`
- 不实现跨实例批量删除（提议 4 的范围）
- 不实现对象元数据编辑（修改 Content-Type 等）
- 不实现 bucket 创建/删除（只浏览已有 bucket）
- 不修改现有分发 / 上传 / 连通性测试逻辑
- 不引入第三方 XML 解析库（沿用正则风格）
- 不引入对象存储 SDK（沿用手写 SigV4）
