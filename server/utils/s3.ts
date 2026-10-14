import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  type DeleteObjectsCommandInput,
  type DeleteObjectsCommandOutput,
} from '@aws-sdk/client-s3'
import type { FinalizeRequestMiddleware } from '@aws-sdk/types'
import type { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import type { S3Instance, ConnectivityResult } from '#shared/schemas/groups'
import type {
  BucketInfo,
  ObjectInfo,
  ListObjectsResult,
  DeleteObjectsResult,
} from '#shared/schemas/browse'
// ===== 客户端创建 =====

export function createS3Client(instance: S3Instance): S3Client {
  return new S3Client({
    endpoint: instance.endpoint,
    region: instance.region?.trim() || 'us-east-1',
    credentials: {
      accessKeyId: instance.accessKey,
      secretAccessKey: instance.secretKey,
    },
    forcePathStyle: true,
  })
}

// ===== 连通性测试 =====

/** MinIO 系 health 路径（MinIO / SILO / RustFS 均提供） */
const MINIO_HEALTH_PATH = '/minio/health/live'

type LivenessProbe =
  | { kind: 'minio-health'; latency: number }
  | { kind: 's3-auth-ok'; latency: number }
  | { kind: 's3-reachable'; latency: number }
  | { kind: 'offline'; error: string }

function networkErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'AbortError') return '连接超时'
    const parts = (e as { errors?: unknown[] }).errors
    if (parts?.length) {
      return parts.map((x) => (x instanceof Error ? x.message : String(x))).join('; ')
    }
    return e.message || '网络不可达'
  }
  return '网络不可达'
}

/**
 * 探活：优先 MinIO 系 /minio/health/live；
 * 该路径不存在或不可用时降级用 ListBuckets（标准 S3，兼作凭据校验）。
 */
async function probeLiveness(instance: S3Instance): Promise<LivenessProbe> {
  const start = Date.now()
  const healthUrl = `${instance.endpoint}${MINIO_HEALTH_PATH}`

  // 1) MinIO 系 health（无需鉴权）
  let healthUnsupported = false
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(healthUrl, { signal: controller.signal })
    clearTimeout(timeout)
    if (res.ok) {
      return { kind: 'minio-health', latency: Date.now() - start }
    }
    // 服务有响应但无此路径（404/405 等）→ 降级
    healthUnsupported = true
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      // health 超时：端点可能仍在，继续用 S3 探活
      healthUnsupported = true
    } else {
      // 连接被拒等：多半整机不可达，仍尝试 S3 探活（有些网关只暴露 S3 端口）
      healthUnsupported = true
    }
  }

  // 2) 降级：ListBuckets（200=在线且凭据有效；403=在线但凭据无效）
  if (healthUnsupported) {
    try {
      const client = createS3Client(instance)
      await client.send(new ListBucketsCommand({}), { requestTimeout: 10000 })
      return { kind: 's3-auth-ok', latency: Date.now() - start }
    } catch (e: unknown) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
      const statusCode = err.$metadata?.httpStatusCode
      if (statusCode === 403 || err.name === 'AccessDenied') {
        return { kind: 's3-reachable', latency: Date.now() - start }
      }
      if (statusCode && statusCode < 500) {
        // 有 HTTP 响应即视为服务可达（签名/参数类错误）
        return { kind: 's3-reachable', latency: Date.now() - start }
      }
      return { kind: 'offline', error: networkErrorMessage(e) }
    }
  }

  return { kind: 'offline', error: '探活失败' }
}

export async function testConnectivity(instance: S3Instance): Promise<ConnectivityResult> {
  const result: ConnectivityResult = {
    instanceId: instance.id,
    instanceName: instance.name,
    endpoint: instance.endpoint,
    online: false,
  }

  // Step 1: 探活（MinIO health → 降级 ListBuckets）
  const probe = await probeLiveness(instance)
  if (probe.kind === 'offline') {
    result.online = false
    result.error = probe.error
    return result
  }

  result.online = true
  result.latency = probe.latency

  // Step 2: 凭据校验（降级路径若已用 ListBuckets 成功，可直接认定）
  if (probe.kind === 's3-auth-ok') {
    result.authValid = true
    return result
  }

  try {
    const client = createS3Client(instance)
    await client.send(new ListBucketsCommand({}), { requestTimeout: 10000 })
    result.authValid = true
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } }
    const statusCode = err.$metadata?.httpStatusCode
    if (statusCode === 403 || err.name === 'AccessDenied') {
      result.authValid = false
      result.authError = '403 Access Denied'
    } else {
      result.authValid = undefined
      result.authError = err.name || 'SDK 错误'
    }
  }

  return result
}

// ===== 整组并发测试 =====

export async function testGroupConnectivity(
  instances: S3Instance[],
): Promise<ConnectivityResult[]> {
  const enabled = instances.filter((i) => i.enabled)
  return Promise.all(enabled.map((inst) => testConnectivity(inst)))
}

// ===== 实例访问：Bucket / Object 操作 =====

/** 格式化 S3 SDK 错误为可读字符串 */
function formatS3Error(e: unknown): string {
  const err = e as {
    name?: string
    $metadata?: { httpStatusCode?: number }
    message?: string
    errors?: unknown[]
    cause?: unknown
  }
  // AggregateError（连接被拒等）：message 常为空，从 errors[] 取有效信息
  if (err.errors?.length) {
    const parts = err.errors.map((x) => (x instanceof Error ? x.message : String(x)))
    const joined = parts.filter(Boolean).join('; ')
    if (joined) return joined
  }
  const statusCode = err.$metadata?.httpStatusCode
  if (statusCode === 403 || err.name === 'AccessDenied') return '403 Access Denied'
  if (statusCode === 404) return '404 Not Found'
  return err.message || err.name || 'S3 错误'
}

/** 执行器统一错误文案（覆盖 AggregateError / 空 message） */
export function formatExecError(err: unknown): string {
  if (err instanceof Error) {
    const agg = err as Error & { errors?: unknown[] }
    if (agg.errors?.length) {
      const joined = agg.errors
        .map((x) => (x instanceof Error ? x.message : String(x)))
        .filter(Boolean)
        .join('; ')
      if (joined) return joined
    }
    return err.message || err.name || String(err)
  }
  return String(err)
}

/**
 * 获取实例的 bucket 列表（含创建时间）。
 *
 * 调用 SDK ListBucketsCommand，返回 bucket 名称和创建日期。
 * 与连通性测试中的 ListBucketsCommand 区别：这里返回完整元数据。
 */
export async function listBucketsWithMeta(instance: S3Instance): Promise<{
  buckets: BucketInfo[]
  error?: string
}> {
  try {
    const client = createS3Client(instance)
    const res = await client.send(new ListBucketsCommand({}), {
      requestTimeout: 10000,
    })
    const buckets: BucketInfo[] = (res.Buckets ?? [])
      .filter((b) => b.Name)
      .map((b) => ({
        name: b.Name!,
        createdAt: b.CreationDate?.toISOString() ?? '',
      }))
    return { buckets }
  } catch (e: unknown) {
    return { buckets: [], error: formatS3Error(e) }
  }
}

/** ListObjectsV2 单页最大返回数（S3 上限 1000） */
const LIST_MAX_KEYS = 200

/**
 * 清洗 objectKey / prefix，防止路径遍历。
 *
 * - 反斜杠归一化为正斜杠
 * - 去掉每段开头的点（防 . 和 ..）
 * - 过滤掉空段和 ..
 * - 重新用 / 拼接
 */
export function sanitizeObjectKey(key: string): string {
  return key
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.replace(/^\.+/, ''))
    .filter((seg) => seg.length > 0 && seg !== '..')
    .join('/')
}

/**
 * 列出 bucket 下指定前缀的对象和子前缀（虚拟文件夹模式）。
 *
 * 调用 SDK ListObjectsV2Command，delimiter='/' 模拟文件夹结构。
 * SDK 处理签名和 XML 解析，返回对象列表 + 公共前缀 + 分页游标。
 *
 * @param prefix            对象前缀，空字符串表示根
 * @param delimiter         分隔符，通常为 '/'（模拟虚拟文件夹）
 * @param continuationToken 上一页返回的 NextContinuationToken
 */
export async function listObjects(
  instance: S3Instance,
  bucket: string,
  prefix: string,
  delimiter: string = '/',
  continuationToken?: string,
): Promise<ListObjectsResult> {
  try {
    const client = createS3Client(instance)
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: delimiter,
        MaxKeys: LIST_MAX_KEYS,
        ContinuationToken: continuationToken,
      }),
      { requestTimeout: 30000 },
    )

    const objects: ObjectInfo[] = (res.Contents ?? [])
      .filter((c) => c.Key)
      .map((c) => ({
        key: c.Key!,
        size: c.Size ?? 0,
        lastModified: c.LastModified?.toISOString() ?? '',
        etag: c.ETag?.replace(/"/g, ''),
      }))

    const commonPrefixes: string[] = (res.CommonPrefixes ?? [])
      .map((cp) => cp.Prefix!)
      .filter(Boolean)

    return {
      objects,
      commonPrefixes,
      isTruncated: res.IsTruncated ?? false,
      continuationToken: res.NextContinuationToken,
    }
  } catch (e: unknown) {
    return {
      objects: [],
      commonPrefixes: [],
      isTruncated: false,
      error: formatS3Error(e),
    }
  }
}

// ===== 删除对象 =====


/**
 * 批量删除对象（S3 DeleteMultipleObjects API）。
 *
 * SDK DeleteObjectsCommand，一次最多 1000 个。
 */
export async function deleteObjects(
  instance: S3Instance,
  bucket: string,
  keys: string[],
): Promise<DeleteObjectsResult> {
  if (!keys.length) return { deleted: [], errors: [] }

  // 自动分批（每批 1000 个，S3 API 单次上限）
  const allDeleted: string[] = []
  const allErrors: { key: string; error: string }[] = []

  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    const result = await deleteObjectsBatch(instance, bucket, batch)
    allDeleted.push(...result.deleted)
    allErrors.push(...result.errors)
  }

  return { deleted: allDeleted, errors: allErrors }
}

/**
 * 单次 DeleteMultipleObjects 调用（最多 1000 个 key）。
 * 由 deleteObjects 和 deleteByPrefixes 内部调用。
 */
async function deleteObjectsBatch(
  instance: S3Instance,
  bucket: string,
  keys: string[],
): Promise<DeleteObjectsResult> {
  if (!keys.length) return { deleted: [], errors: [] }

  try {
    const client = createS3Client(instance)
    const command = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: keys.map((k) => ({ Key: k })),
        Quiet: false,
      },
    })

    // DeleteObjects 需要 Content-MD5 头，SDK v3 不自动添加
    // 通过 command 级 middleware 注入
    const md5Middleware: FinalizeRequestMiddleware<DeleteObjectsCommandInput, DeleteObjectsCommandOutput> =
      next => async (args) => {
        const req = args.request as { body?: string | Uint8Array; headers?: Record<string, string> } | undefined
        if (req?.body) {
          const bodyStr =
            typeof req.body === 'string'
              ? req.body
              : new TextDecoder().decode(req.body as Uint8Array)
          const md5 = createHash('md5').update(bodyStr).digest('base64')
          req.headers = { ...req.headers, 'Content-MD5': md5 }
        }
        return next(args)
      }

    command.middlewareStack.addRelativeTo(md5Middleware, {
      name: 'addContentMD5',
      relation: 'before',
      toMiddleware: 'awsAuthMiddleware',
    })

    const res = await client.send(command, { requestTimeout: 30000 })

    const deleted = (res.Deleted ?? []).map((d) => d.Key!).filter(Boolean)
    const errors = (res.Errors ?? []).map((e) => ({
      key: e.Key!,
      error: `${e.Code}: ${e.Message}`,
    }))

    return { deleted, errors }
  } catch (e: unknown) {
    return {
      deleted: [],
      errors: keys.map((k) => ({ key: k, error: formatS3Error(e) })),
    }
  }
}

/**
 * 递归删除指定前缀下的所有对象。
 *
 * 先用 listObjects（delimiter="" 递归列出）分页收集全部 key，
 * 再分批调 deleteObjects（每批 1000 个）。
 */
export async function deleteByPrefixes(
  instance: S3Instance,
  bucket: string,
  prefixes: string[],
): Promise<DeleteObjectsResult> {
  const allDeleted: string[] = []
  const allErrors: { key: string; error: string }[] = []

  for (const prefix of prefixes) {
    const keys: string[] = []
    let token: string | undefined
    do {
      const result = await listObjects(instance, bucket, prefix, '', token)
      if (result.error) {
        allErrors.push({ key: prefix, error: `列出对象失败: ${result.error}` })
        break
      }
      keys.push(...result.objects.map((o) => o.key))
      token = result.isTruncated ? result.continuationToken : undefined
    } while (token)

    // 跳过因列出失败而中断的前缀
    const prefixHasError = allErrors.some((e) => e.key === prefix)
    if (prefixHasError) continue

    // deleteObjects 内部自动分批
    const result = await deleteObjects(instance, bucket, keys)
    allDeleted.push(...result.deleted)
    allErrors.push(...result.errors)
  }

  return { deleted: allDeleted, errors: allErrors }
}

// ===== 下载对象 =====

/**
 * 获取对象内容流（S3 GetObject）。
 *
 * 返回 Node Readable + 元数据，调用方管道转发给浏览器。
 * 支持 Range 请求头（视频预览）。
 * 不缓冲整个文件到内存，支持大文件流式下载。
 */
export async function getObjectStream(
  instance: S3Instance,
  bucket: string,
  objectKey: string,
  rangeHeader?: string,
): Promise<{
  stream: Readable | null
  metadata: {
    contentType: string
    contentLength: number
    contentRange: string
    etag: string
    lastModified: string
    statusCode: number
  } | null
  error?: string
}> {
  try {
    const client = createS3Client(instance)
    const input: { Bucket: string; Key: string; Range?: string } = {
      Bucket: bucket,
      Key: objectKey,
    }
    if (rangeHeader) input.Range = rangeHeader

    const res = await client.send(new GetObjectCommand(input), {
      requestTimeout: 600000,
    })

    return {
      stream: res.Body as Readable,
      metadata: {
        contentType: res.ContentType ?? 'application/octet-stream',
        contentLength: res.ContentLength ?? 0,
        contentRange: res.ContentRange ?? '',
        etag: res.ETag ?? '',
        lastModified: res.LastModified?.toISOString() ?? '',
        statusCode: res.$metadata.httpStatusCode ?? 200,
      },
    }
  } catch (e: unknown) {
    return { stream: null, metadata: null, error: formatS3Error(e) }
  }
}

// ===== 上传对象 =====

/**
 * 流式上传对象（后端转发，不落盘）。
 *
 * SDK PutObjectCommand，Content-Type 显式指定。
 * 注意：SDK 本身不会改写 Content-Type；历史上出现的 `;charset=utf-8`
 * 是 Bun 运行时 formData() 解析 multipart 时附加的（见 dispatch/stage.post.ts），
 * 所以上游传入的 contentType 必须是按扩展名推断出的纯净值。
 */
export async function uploadObjectStream(
  instance: S3Instance,
  bucket: string,
  objectKey: string,
  body: Readable | ReadableStream | Blob | Uint8Array,
  contentType: string,
  contentLength?: number,
): Promise<void> {
  const client = createS3Client(instance)
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { requestTimeout: 600000 },
  )
}

/** MIME 类型推断表 */
const MIME_TABLE: Record<string, string> = {
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.log': 'text/plain',
  '.md': 'text/markdown',
}

/**
 * 根据文件扩展名推断 Content-Type。
 * 无扩展名或未命中时回退 application/octet-stream。
 */
export function inferContentType(filename: string): string {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex < 0) return 'application/octet-stream'
  const ext = filename.slice(dotIndex).toLowerCase()
  return MIME_TABLE[ext] ?? 'application/octet-stream'
}

// ===== 复制/移动对象 =====

/**
 * 跨实例复制单个对象：源端 GetObject -> 目标端 PutObject。
 * 不落盘，后端流式直传。
 *
 * 同实例时可用 CopyObjectCommand（服务端复制，更快）；
 * 跨实例时必须 GetObject + PutObject 流式直传。
 */
export async function copyObjectStream(
  sourceInstance: S3Instance,
  sourceBucket: string,
  sourceKey: string,
  targetInstance: S3Instance,
  targetBucket: string,
  targetKey: string,
  contentType?: string,
): Promise<void> {
  // 同实例同 endpoint：服务端复制
  if (sourceInstance.endpoint === targetInstance.endpoint) {
    const client = createS3Client(targetInstance)
    await client.send(
      new CopyObjectCommand({
        Bucket: targetBucket,
        Key: targetKey,
        // CopySource 需 URL 编码：key 含中文/特殊字符时直接放入 HTTP header 会报
        // "Invalid character in header content ["x-amz-copy-source"]"
        CopySource: `${sourceBucket}/${encodeURIComponent(sourceKey)}`,
        ContentType: contentType,
        MetadataDirective: contentType ? 'REPLACE' : 'COPY',
      }),
      { requestTimeout: 600000 },
    )
    return
  }

  // 跨实例：GetObject -> PutObject 流式直传
  const { stream, metadata, error } = await getObjectStream(sourceInstance, sourceBucket, sourceKey)
  if (error || !stream) throw new Error(`获取源对象失败: ${error}`)

  // 缓冲成 Buffer 再上传：AWS SDK v3 对 Node Readable stream 默认用 chunked
  // transfer encoding（不发 Content-Length 头），旧版 MinIO 不支持 chunked
  // upload 会报错 "You must provide the Content-Length HTTP header."。
  // 缓冲成 Buffer 后 SDK 能正确设置 Content-Length，代价是内存占用=文件大小。
  // 参见技术文档 6.1 节流式直传风险。
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })

  await uploadObjectStream(
    targetInstance,
    targetBucket,
    targetKey,
    buffer,
    contentType ?? metadata?.contentType ?? 'application/octet-stream',
    metadata?.contentLength,
  )
}

/**
 * 递归收集前缀下所有对象 key（用于复制/移动）。
 *
 * delimiter="" 递归列出，分页收集。
 * 超过 COPY_MOVE_MAX_OBJECTS 上限时抛错。
 */
export async function collectObjectsByPrefixes(
  instance: S3Instance,
  bucket: string,
  prefixes: string[],
  maxObjects: number = Number(process.env.COPY_MOVE_MAX_OBJECTS) || 10000,
): Promise<{ keys: string[]; error?: string }> {
  const allKeys: string[] = []
  for (const prefix of prefixes) {
    let token: string | undefined
    do {
      const result = await listObjects(instance, bucket, prefix, '', token)
      if (result.error) {
        return { keys: [], error: `列出文件夹失败: ${result.error}` }
      }
      allKeys.push(...result.objects.map((o) => o.key))
      token = result.isTruncated ? result.continuationToken : undefined

      if (maxObjects > 0 && allKeys.length > maxObjects) {
        return {
          keys: [],
          error: `源对象超过 ${maxObjects} 个上限，请缩小范围`,
        }
      }
    } while (token)
  }
  return { keys: allKeys }
}
