# 技术方案：XML 解析重构

> 用 `fast-xml-parser` 替换 `server/utils/minio.ts` 中手搓 regex XML 解析与序列化。

## 1. 背景与动机

当前 `server/utils/minio.ts` 中的 XML 解析和转义全部手搓 regex 实现。已出过 bug：`&#39;` 数字字符引用未处理，导致含单引号文件名预览 502 + 同步 404。手搓 regex 还有 CDATA 段、嵌套标签、注释等未处理的边界隐患。

## 2. 选型结论

**采用 `fast-xml-parser`**（v5.x）。

| 维度 | fast-xml-parser | xml2js | saxon-js |
|---|---|---|---|
| 体积 | ~26K（parser+builder） | 较大 | 3.7 MB |
| 解析+构建 | ✅ XMLParser + XMLBuilder | ✅ | ❌ XSLT 处理器 |
| 维护 | v5.10.0，活跃 | 3 年未更新 | 2 年未更新 |
| TS 支持 | 自带 .d.ts | 需 @types/xml2js | 冷门 |
| 许可 | MIT | MIT | 非开源 |

- 零 native 依赖，Bun 原生兼容。
- 不违反项目"零 AWS SDK 依赖"原则（该原则针对 SDK，XML 解析库是纯工具）。
- `XMLBuilder` 可替代手写 XML 序列化，自动处理实体转义。

## 3. 改写范围

### 3.1 需要替换的函数（共 6 个）

| 函数 | 行号 | 用途 | 替换方式 |
|---|---|---|---|
| `extractXmlTag` | 873 | 从 XML 提取单个标签值（UploadId 等） | 用 XMLParser 解析后直接取属性路径 |
| `parseBucketNames` | 413 | 解析 ListBuckets 响应，提取 bucket 名 | XMLParser 解析后遍历 `Buckets.Bucket` 数组 |
| `parseListObjectsXml` | 1039 | 解析 ListObjectsV2 响应 | XMLParser 解析后遍历 `Contents`/`CommonPrefixes` |
| `parseDeleteResultXml` | 1188 | 解析 DeleteMultipleObjects 响应 | XMLParser 解析后遍历 `Deleted`/`Error` |
| `escapeXml` | 1157 | XML 特殊字符转义 | 删除，XMLBuilder 自动转义 |
| `unescapeXml` | 1167 | XML 特殊字符反转义 | 删除，XMLParser 自动反转义 |

### 3.2 需要替换的 XML 序列化（共 2 处）

| 位置 | 行号 | 用途 | 替换方式 |
|---|---|---|---|
| `deleteObjects` 内 | 1099-1103 | 构造 DeleteMultipleObjects 请求体 | XMLBuilder 构建 |
| `completeMultipartUpload` 内 | 669 | 构造 CompleteMultipartUpload 请求体 | XMLBuilder 构建 |

### 3.3 `extractXmlTag` 的调用点（共 5 处）

| 调用位置 | 提取的标签 | 用途 |
|---|---|---|
| `initiateMultipartUpload` (614) | `UploadId` | 创建 multipart 后拿 uploadId |
| `parseListObjectsXml` (1048-1069) | `Key`/`Size`/`LastModified`/`ETag`/`IsTruncated`/`NextContinuationToken` | 解析对象列表 |
| `parseDeleteResultXml` (1203-1205) | `Key`/`Code`/`Message` | 解析删除结果 |

## 4. 实施方案

### 4.1 安装依赖

```bash
bun add fast-xml-parser
```

### 4.2 模块级单例

在 `server/utils/minio.ts` 顶部新增：

```ts
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

/** S3 XML 解析器单例 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  // S3 XML 单元素时不返回数组，用 isArray 钩子强制转为数组
  isArray: (name, _node, _path) => [
    'Contents', 'CommonPrefixes', 'Bucket', 'Deleted', 'Error', 'Part',
  ].includes(name),
})

/** S3 XML 构建器单例（紧凑单行输出，省传输字节） */
const xmlBuilder = new XMLBuilder({
  format: false,
  ignoreAttributes: false,
  suppressEmptyNode: true,
})
```

### 4.3 解析函数改写

#### `parseBucketNames`

```ts
function parseBucketNames(xml: string): string[] {
  const parsed = xmlParser.parse(xml)
  const buckets = parsed?.ListBucketsResult?.Buckets?.Bucket
  if (!buckets) return []
  // isArray 钩子保证 buckets 一定是数组
  return buckets.map((b: any) => b.Name).filter(Boolean)
}
```

#### `parseListObjectsXml`

```ts
function parseListObjectsXml(xml: string): ListObjectsResult {
  const parsed = xmlParser.parse(xml)
  const root = parsed?.ListBucketResult

  const objects: ObjectInfo[] = (root?.Contents ?? []).map((c: any) => ({
    key: c.Key ?? '',
    size: c.Size ? parseInt(String(c.Size), 10) : 0,
    lastModified: c.LastModified ?? '',
    etag: c.ETag?.replace(/"/g, ''),
  }))

  const commonPrefixes: string[] = (root?.CommonPrefixes ?? [])
    .map((cp: any) => cp.Prefix)
    .filter(Boolean)

  return {
    objects,
    commonPrefixes,
    isTruncated: root?.IsTruncated === 'true',
    continuationToken: root?.NextContinuationToken ?? undefined,
  }
}
```

#### `parseDeleteResultXml`

```ts
function parseDeleteResultXml(xml: string, requestedKeys: string[]): DeleteObjectsResult {
  const parsed = xmlParser.parse(xml)
  const root = parsed?.DeleteResult

  const deleted: string[] = (root?.Deleted ?? [])
    .map((d: any) => d.Key)
    .filter(Boolean)

  const errors: { key: string, error: string }[] = (root?.Error ?? [])
    .map((e: any) => ({
      key: e.Key ?? '',
      error: `${e.Code || 'Error'}: ${e.Message ?? ''}`,
    }))
    .filter(e => e.key)

  // 兜底：未在响应中出现的 key 视为删除成功
  const accounted = new Set([...deleted, ...errors.map(e => e.key)])
  for (const k of requestedKeys) {
    if (!accounted.has(k)) deleted.push(k)
  }

  return { deleted, errors }
}
```

#### `extractXmlTag` 改写

`extractXmlTag` 当前用于提取单个标签值（如 `UploadId`）。改用 XMLParser 后，直接在调用处解析：

```ts
// initiateMultipartUpload 内：
const parsed = xmlParser.parse(await createRes.text())
const uploadId = parsed?.InitiateMultipartUploadResult?.UploadId
```

保留 `extractXmlTag` 函数但内部改用 XMLParser（避免改太多调用点）：

```ts
function extractXmlTag(xml: string, tag: string): string | null {
  const parsed = xmlParser.parse(xml)
  // 递归查找第一个匹配的 tag
  function find(node: any): string | null {
    if (node == null) return null
    if (typeof node !== 'object') return null
    if (tag in node) return String(node[tag])
    for (const v of Object.values(node)) {
      const found = find(v)
      if (found !== null) return found
    }
    return null
  }
  return find(parsed)
}
```

> 注意：`extractXmlTag` 在 `parseListObjectsXml` 和 `parseDeleteResultXml` 内部的调用会随这两个函数整体改写而消失。改写后 `extractXmlTag` 只剩 `initiateMultipartUpload` 一处调用，也可直接内联。

### 4.4 序列化改写

#### `deleteObjects` 请求体

```ts
const body = xmlBuilder.build({
  '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
  Delete: {
    Object: keys.map(k => ({ Key: k })),
    Quiet: 'false',
  },
})
```

#### `completeMultipartUpload` 请求体

```ts
const body = xmlBuilder.build({
  CompleteMultipartUpload: {
    Part: parts.map(p => ({ PartNumber: String(p.partNumber), ETag: p.etag })),
  },
})
```

> 注意：CompleteMultipartUpload 当前没有 `<?xml?>` 声明，保持不变（XMLBuilder 不加 `?xml` 节点时不会输出声明）。

### 4.5 删除的函数

- `escapeXml` -- XMLBuilder 自动转义，不再需要
- `unescapeXml` -- XMLParser 自动反转义，不再需要

## 5. 对上层零影响

- 所有改写函数的**签名和返回类型不变**，上层调用方无需改动。
- `parseBucketNames` -> `listBuckets` 调用
- `parseListObjectsXml` -> `listObjects` 调用
- `parseDeleteResultXml` -> `deleteObjects` 调用
- `extractXmlTag` -> `initiateMultipartUpload` 调用

## 6. 注意事项

1. **`isArray` 钩子**：S3 XML 单元素时不返回数组（如只有一个 bucket 时 `Bucket` 是对象不是数组）。用 `isArray` 钩子强制 `Contents`/`CommonPrefixes`/`Bucket`/`Deleted`/`Error`/`Part` 为数组，避免 `Array.isArray` 检查遗漏。
2. **ETag 引号**：S3 返回的 `<ETag>"abc123"</ETag>` 带引号，fast-xml-parser 会把引号当作值的一部分保留，仍需 `.replace(/"/g, '')`。
3. **签名兼容**：`deleteObjects` 和 `completeMultipartUpload` 的 body 改用 XMLBuilder 后，输出字节可能与手写不一致（如属性顺序、自闭合标签），影响 `sha256Hex(body)` 签名。需确保 builder 输出稳定（`format: false` 下无空白漂移），并用 curl 对拍验证 MinIO 接受。
4. **XML 声明**：`deleteObjects` 当前有 `<?xml version="1.0" encoding="UTF-8"?>` 声明，XMLBuilder 通过 `?xml` 节点生成；`completeMultipartUpload` 当前无声明，保持不变。

## 7. 验证方式

1. `bun run build` 确保编译通过
2. 启动 dev server + 本地 MinIO 容器，端到端测试：
   - 连通性测试（ListBuckets 解析）
   - 对象浏览（ListObjects 解析，含特殊字符文件名）
   - 批量清理（DeleteObjects 解析）
   - 大文件分发（Multipart Upload 的 Initiate + Complete）
   - 实例间同步（流式 Multipart Upload）
