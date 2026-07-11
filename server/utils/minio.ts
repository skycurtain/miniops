import type { MinioInstance, ListObjectsResult, DeleteObjectsResult, ObjectInfo } from '../types'
import { createHash, createHmac } from 'node:crypto'
import { statSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'

/**
 * MinIO 操作封装
 *
 * Phase 2 仅实现连通性测试；Phase 3 会补充 uploadJson 等。
 */

/** 连通性测试结果 */
export interface ConnectivityResult {
  instanceId: string
  instanceName: string
  endpoint: string
  online: boolean
  latency?: number // 毫秒
  error?: string
  /** 凭据是否有效。仅 online=true 时有意义；undefined 表示未检测 */
  authValid?: boolean
  /** 凭据验证失败的错误信息 */
  authError?: string
}

/**
 * 测试单个实例的连通性。
 *
 * 两步验证：
 * ① GET /minio/health/live -- 无需鉴权，验证 MinIO 进程存活 + 网络可达
 * ② listBuckets() -- 需鉴权，验证 accessKey/secretKey 是否正确
 *
 * health/live 通过后追加凭据验证，凭据无效时 authValid=false。
 */
export async function testConnectivity(instance: MinioInstance): Promise<ConnectivityResult> {
  const base: ConnectivityResult = {
    instanceId: instance.id,
    instanceName: instance.name,
    endpoint: instance.endpoint,
    online: false,
  }

  // 规范化 endpoint，去掉尾部斜杠后拼接健康检查路径
  const url = `${instance.endpoint.replace(/\/+$/, '')}/minio/health/live`
  const start = Date.now()

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      // 不跟随重定向，避免误判
      redirect: 'manual',
    })
    clearTimeout(timer)
    const latency = Date.now() - start

    // /minio/health/live 返回 200 即健康；其他状态码也算"可达"（进程在响应）
    if (res.status !== 200) {
      // 非 200 但有响应，说明进程活着，只是健康检查未通过
      return { ...base, online: false, latency, error: `HTTP ${res.status}` }
    }

    // health/live 通过，追加凭据验证（listBuckets 需 SigV4 签名）
    const result: ConnectivityResult = { ...base, online: true, latency }
    const bucketResult = await listBuckets(instance)
    if (bucketResult.error) {
      result.authValid = false
      result.authError = formatAuthError(bucketResult.error)
    }
    else {
      result.authValid = true
    }
    return result
  }
  catch (e: any) {
    const latency = Date.now() - start
    const err = e?.name === 'AbortError' ? '请求超时（5s）' : (e?.cause?.code || e?.message || '连接失败')
    return { ...base, online: false, latency, error: err }
  }
}

/**
 * 格式化凭据验证错误信息，提取关键信息便于用户理解。
 */
function formatAuthError(rawError: string): string {
  if (rawError.includes('403')) return '凭据无效 (403 Access Denied)'
  if (rawError.includes('401')) return '认证失败 (401 Unauthorized)'
  if (rawError.includes('超时')) return '凭据验证超时'
  return rawError
}

/**
 * 批量测试组内实例连通性（并发）。
 */
export async function testGroupConnectivity(instances: MinioInstance[]): Promise<ConnectivityResult[]> {
  return Promise.all(instances.map(inst => testConnectivity(inst)))
}

// ---------- AWS SigV4 预签名 URL ----------

/**
 * URI 编码 objectKey（保留 / 分隔符）。
 *
 * S3 SigV4 canonical URI 要求只保留 A-Za-z0-9-_.~ 和 / 不编码，
 * 其他字符全部 URI 编码。encodeURIComponent 的不编码集更大（额外保留
 * !'()*），与 S3 规范不一致，会导致含这些字符的 key 签名校验失败。
 * 这里在 encodeURIComponent 基础上补齐 !'()* 的编码。
 */
function encodeObjectKey(key: string): string {
  return key
    .split('/')
    .map(seg => encodeURIComponent(seg)
      .replace(/!/g, '%21')
      .replace(/'/g, '%27')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/\*/g, '%2A'))
    .join('/')
}

/**
 * 生成 AWS SigV4 预签名 URL（支持任意 method）。
 *
 * 不依赖任何 SDK，纯 Node crypto 实现。
 * 参考：https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 */
function presignUrl(opts: {
  method: string
  endpoint: string
  bucket: string
  objectKey: string
  accessKey: string
  secretKey: string
  region: string
  expiresIn: number
}): string {
  const { method, endpoint, bucket, objectKey, accessKey, secretKey, region, expiresIn } = opts
  const url = new URL(endpoint.replace(/\/+$/, ''))
  const host = url.host

  // 对象路径：/{bucket}/{key}，key 需 URI 编码（但 / 保留）
  const encodedKey = encodeObjectKey(objectKey)
  const path = `/${bucket}/${encodedKey}`

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)

  // 标准 SigV4 签名参数
  const credential = `${accessKey}/${dateStamp}/${region}/s3/aws4_request`
  const canonicalQuery = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ]

  // 规范请求
  const canonicalQueryString = canonicalQuery
    .map(([k, v]) => `${encodeURIComponent(k ?? '')}=${encodeURIComponent(v ?? '')}`)
    .sort()
    .join('&')

  const canonicalRequest = [
    method,
    path,
    canonicalQueryString,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  // 待签字符串
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  // 签名密钥链
  const kDate = createHmac('sha256', `AWS4${secretKey}`).update(dateStamp).digest()
  const kRegion = createHmac('sha256', kDate).update(region).digest()
  const kService = createHmac('sha256', kRegion).update('s3').digest()
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest()
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  // 拼接最终 URL
  const finalQuery = `${canonicalQueryString}&X-Amz-Signature=${signature}`
  return `${url.protocol}//${host}${path}?${finalQuery}`
}

/**
 * 生成 AWS SigV4 预签名 PUT URL（用于 MinIO/S3 兼容存储）。
 *
 * 不依赖任何 SDK，纯 Node crypto 实现。
 * 参考：https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 */
function presignPutUrl(opts: {
  endpoint: string
  bucket: string
  objectKey: string
  accessKey: string
  secretKey: string
  region: string
  expiresIn: number
}): string {
  return presignUrl({ ...opts, method: 'PUT' })
}

/**
 * 生成 AWS SigV4 预签名 GET URL（用于下载对象）。
 * 复用 presignUrl，method 改为 GET。
 */
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

/**
 * 上传 JSON 文件到 MinIO。
 *
 * 用预签名 PUT URL 上传，手动指定 Content-Type: application/json。
 * 原因：SDK 的 write() 会自动追加 ;charset=utf-8，
 * 导致 MinIO Console 预览失败（触发下载）。
 */
export async function uploadJson(
  instance: MinioInstance,
  bucket: string,
  filename: string,
  content: string,
): Promise<void> {
  const presignedUrl = presignPutUrl({
    endpoint: instance.endpoint,
    bucket,
    objectKey: filename,
    accessKey: instance.accessKey,
    secretKey: instance.secretKey,
    region: 'us-east-1', // MinIO 默认 region
    expiresIn: 3600,
  })

  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: content,
    headers: { 'Content-Type': 'application/json' },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`上传失败: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 200)}` : ''}`)
  }
}

// ---------- AWS SigV4 签名请求（Authorization 头方式） ----------

/**
 * 生成 AWS SigV4 Authorization 头（用于直接请求 MinIO/S3 API）。
 * 与预签名 URL 不同，这里把签名放在 Authorization 头里。
 */
function signRequest(opts: {
  method: string
  endpoint: string
  path: string
  queryString: string
  accessKey: string
  secretKey: string
  region: string
  payloadHash: string
}): { authorization: string, amzDate: string } {
  const { method, endpoint, path, queryString, accessKey, secretKey, region, payloadHash } = opts
  const url = new URL(endpoint.replace(/\/+$/, ''))
  const host = url.host

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)

  // 规范请求
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\n`
  const signedHeaders = 'host;x-amz-content-sha256'

  const canonicalRequest = [
    method,
    path,
    queryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  // 待签字符串
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  // 签名密钥链
  const kDate = createHmac('sha256', `AWS4${secretKey}`).update(dateStamp).digest()
  const kRegion = createHmac('sha256', kDate).update(region).digest()
  const kService = createHmac('sha256', kRegion).update('s3').digest()
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest()
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return { authorization, amzDate }
}

/** ListBuckets 结果 */
export interface ListBucketsResult {
  instanceId: string
  buckets: string[]
  error?: string
}

/**
 * 获取实例的 bucket 列表。
 *
 * 调用 S3 ListBuckets API (GET /)，用 SigV4 Authorization 头签名。
 * 返回 bucket 名称数组。
 */
export async function listBuckets(instance: MinioInstance): Promise<ListBucketsResult> {
  const endpoint = instance.endpoint.replace(/\/+$/, '')
  const url = new URL(endpoint)
  const host = url.host
  const path = '/'
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
  const timer = setTimeout(() => controller.abort(), 10000)

  try {
    const res = await fetch(`${endpoint}/`, {
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

    if (!res.ok && res.status !== 206) {
      const body = await res.text().catch(() => '')
      return {
        instanceId: instance.id,
        buckets: [],
        error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      }
    }

    // 解析 XML 响应：<ListBucketsResult><Buckets><Bucket><Name>xxx</Name></Bucket>...</Buckets></ListBucketsResult>
    const xml = await res.text()
    const buckets = parseBucketNames(xml)
    return { instanceId: instance.id, buckets }
  }
  catch (e: any) {
    clearTimeout(timer)
    const err = e?.name === 'AbortError' ? '请求超时（10s）' : (e?.cause?.code || e?.message || '连接失败')
    return { instanceId: instance.id, buckets: [], error: err }
  }
}

/**
 * 批量获取多个实例的 bucket 列表（并发）。
 */
export async function listBucketsBatch(instances: MinioInstance[]): Promise<ListBucketsResult[]> {
  return Promise.all(instances.map(inst => listBuckets(inst)))
}

/**
 * 从 ListBuckets XML 响应中解析 bucket 名称列表。
 *
 * MinIO 返回格式：
 * <ListBucketsResult>
 *   <Buckets>
 *     <Bucket><Name>bucket1</Name><CreationDate>...</CreationDate></Bucket>
 *     <Bucket><Name>bucket2</Name><CreationDate>...</CreationDate></Bucket>
 *   </Buckets>
 * </ListBucketsResult>
 */
function parseBucketNames(xml: string): string[] {
  const names: string[] = []
  // 用正则提取所有 <Name>...</Name>（在 Bucket 上下文中）
  const regex = /<Bucket>\s*<Name>([^<]+)<\/Name>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) {
    if (match[1]) names.push(match[1])
  }
  return names
}

// ---------- 通用对象上传（V2：小文件单次 PUT + 大文件 multipart） ----------

/** 分片上传阈值：小于此值走单次 PUT，否则走 multipart（默认 8MB） */
const MULTIPART_THRESHOLD = Number(process.env.MULTIPART_THRESHOLD) || 8 * 1024 * 1024
/** 分片大小（S3 最小 5MB，默认 5MB） */
const PART_SIZE = Number(process.env.MULTIPART_PART_SIZE) || 5 * 1024 * 1024
/** 空内容的 sha256（用于 InitiateMultipartUpload，body 为空） */
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
/** 流式上传的 payloadHash 占位符（S3 规范允许，无需计算 body sha256） */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

/**
 * 上传一个磁盘文件到 MinIO（统一入口）。
 *
 * - 小文件（< MULTIPART_THRESHOLD）：单次 PUT，复用 presignPutUrl
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
): Promise<void> {
  const size = statSync(localPath).size
  if (size < MULTIPART_THRESHOLD) {
    await uploadSmall(instance, bucket, objectKey, localPath, contentType)
  }
  else {
    await uploadLarge(instance, bucket, objectKey, localPath, contentType)
  }
}

/**
 * 小文件上传：复用 presignPutUrl，body 从磁盘文件读取。
 * 精确指定 Content-Type，规避 SDK 自动追加 ;charset=utf-8 的老问题。
 */
async function uploadSmall(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  localPath: string,
  contentType: string,
): Promise<void> {
  const fileBuffer = await readFile(localPath)

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
    body: fileBuffer,
    headers: { 'Content-Type': contentType },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`上传失败: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 200)}` : ''}`)
  }
}

/**
 * 大文件上传：手写 S3 Multipart Upload 三步。
 *
 * ① Initiate (POST ?uploads) → 拿 UploadId
 * ② UploadPart ×N (PUT ?partNumber=N&uploadId=X) → 收集 ETag
 * ③ Complete (POST ?uploadId=X, body=XML) → 完成
 *
 * 失败时调 abortMultipartUpload 清理 MinIO 侧残留，避免占用空间。
 */
async function uploadLarge(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  localPath: string,
  contentType: string,
): Promise<void> {
  const endpoint = instance.endpoint.replace(/\/+$/, '')
  const encodedKey = encodeObjectKey(objectKey)
  const path = `/${bucket}/${encodedKey}`
  const host = new URL(endpoint).host

  // ① 创建 multipart upload
  const createQuery = 'uploads='
  const { authorization: a1, amzDate: d1 } = signRequest({
    method: 'POST', endpoint, path, queryString: createQuery,
    accessKey: instance.accessKey, secretKey: instance.secretKey,
    region: 'us-east-1', payloadHash: EMPTY_SHA256,
  })
  const createRes = await fetch(`${endpoint}${path}?uploads`, {
    method: 'POST',
    headers: {
      'Host': host,
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': d1,
      'Authorization': a1,
      'Content-Type': contentType,
    },
  })
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '')
    throw new Error(`创建 multipart 失败: ${createRes.status} ${createRes.statusText}${body ? ` - ${body.slice(0, 200)}` : ''}`)
  }
  const uploadId = extractXmlTag(await createRes.text(), 'UploadId')
  if (!uploadId) throw new Error('创建 multipart 失败: 未拿到 UploadId')

  // ② 逐片上传
  const size = statSync(localPath).size
  const parts: { partNumber: number, etag: string }[] = []
  const partCount = Math.ceil(size / PART_SIZE)
  const fd = await open(localPath, 'r')

  try {
    for (let n = 1; n <= partCount; n++) {
      const start = (n - 1) * PART_SIZE
      const end = Math.min(start + PART_SIZE, size)
      const chunk = Buffer.alloc(end - start)
      await fd.read(chunk, 0, chunk.length, start)

      const partQuery = `partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`
      const { authorization: a2, amzDate: d2 } = signRequest({
        method: 'PUT', endpoint, path, queryString: partQuery,
        accessKey: instance.accessKey, secretKey: instance.secretKey,
        region: 'us-east-1', payloadHash: UNSIGNED_PAYLOAD,
      })
      const partRes = await fetch(`${endpoint}${path}?${partQuery}`, {
        method: 'PUT',
        body: chunk,
        headers: {
          'Host': host,
          'x-amz-content-sha256': UNSIGNED_PAYLOAD,
          'x-amz-date': d2,
          'Authorization': a2,
        },
      })
      if (!partRes.ok) {
        const body = await partRes.text().catch(() => '')
        throw new Error(`分片 ${n}/${partCount} 上传失败: ${partRes.status}${body ? ` - ${body.slice(0, 200)}` : ''}`)
      }
      const etag = partRes.headers.get('etag')
      if (!etag) throw new Error(`分片 ${n} 未返回 ETag`)
      parts.push({ partNumber: n, etag: etag.replace(/"/g, '') })
    }

    // ③ 完成
    const completeBody = `<CompleteMultipartUpload>${parts.map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
    const completeQuery = `uploadId=${encodeURIComponent(uploadId)}`
    const completeHash = sha256Hex(completeBody)
    const { authorization: a3, amzDate: d3 } = signRequest({
      method: 'POST', endpoint, path, queryString: completeQuery,
      accessKey: instance.accessKey, secretKey: instance.secretKey,
      region: 'us-east-1', payloadHash: completeHash,
    })
    const completeRes = await fetch(`${endpoint}${path}?${completeQuery}`, {
      method: 'POST',
      body: completeBody,
      headers: {
        'Host': host,
        'x-amz-content-sha256': completeHash,
        'x-amz-date': d3,
        'Authorization': a3,
        'Content-Type': 'application/xml',
      },
    })
    if (!completeRes.ok) {
      const body = await completeRes.text().catch(() => '')
      throw new Error(`完成 multipart 失败: ${completeRes.status}${body ? ` - ${body.slice(0, 200)}` : ''}`)
    }
  }
  catch (e) {
    // 中止上传，避免 MinIO 侧残留未完成的 upload（占用空间）
    await abortMultipartUpload(instance, bucket, objectKey, uploadId).catch(() => {})
    throw e
  }
  finally {
    await fd.close()
  }
}

/**
 * 中止 multipart upload，清理 MinIO 侧残留。
 * DELETE /{bucket}/{key}?uploadId=X，用 signRequest 签名。
 */
async function abortMultipartUpload(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  uploadId: string,
): Promise<void> {
  const endpoint = instance.endpoint.replace(/\/+$/, '')
  const encodedKey = encodeObjectKey(objectKey)
  const path = `/${bucket}/${encodedKey}`
  const host = new URL(endpoint).host

  const query = `uploadId=${encodeURIComponent(uploadId)}`
  const { authorization, amzDate } = signRequest({
    method: 'DELETE', endpoint, path, queryString: query,
    accessKey: instance.accessKey, secretKey: instance.secretKey,
    region: 'us-east-1', payloadHash: EMPTY_SHA256,
  })
  await fetch(`${endpoint}${path}?${query}`, {
    method: 'DELETE',
    headers: {
      'Host': host,
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': amzDate,
      'Authorization': authorization,
    },
  })
}

// ---------- 辅助函数 ----------

/** 计算字符串的 sha256 十六进制摘要（用于 CompleteMultipartUpload 的 body 签名） */
function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 从 XML 响应中提取单个标签的文本内容 */
function extractXmlTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return m?.[1] ?? null
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
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
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

/**
 * 清洗 objectKey，防止 path traversal。
 *
 * - 反斜杠归一化为正斜杠
 * - 去掉每段开头的点（防 `.` 和 `..`）
 * - 过滤掉空段和 `..`
 * - 重新用 / 拼接
 */
export function sanitizeObjectKey(key: string): string {
  return key
    .replace(/\\/g, '/')
    .split('/')
    .map(seg => seg.replace(/^\.+/, ''))
    .filter(seg => seg.length > 0 && seg !== '..')
    .join('/')
}

// ---------- 对象浏览：ListObjectsV2 / DeleteMultipleObjects / GetObject ----------

/** ListObjectsV2 单页最大返回数（S3 上限 1000） */
const LIST_MAX_KEYS = 1000

/**
 * 列出 bucket 下指定前缀的对象和子前缀（虚拟文件夹）。
 *
 * 调用 S3 ListObjectsV2 API (GET /{bucket}?list-type=2&prefix=&delimiter=/)。
 * 用 signRequest 签名，解析 XML 的 <Contents> 和 <CommonPrefixes>。
 *
 * @param prefix     对象前缀，空字符串表示根
 * @param delimiter  分隔符，通常为 '/'（模拟虚拟文件夹）
 * @param continuationToken 上一页返回的 NextContinuationToken，用于分页
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

  // 构建 query 参数（签名要求按 key 字母序）
  const queryParams: [string, string][] = [
    ['list-type', '2'],
    ['prefix', prefix],
    ['delimiter', delimiter],
    ['max-keys', String(LIST_MAX_KEYS)],
  ]
  if (continuationToken) {
    queryParams.push(['continuation-token', continuationToken])
  }
  queryParams.sort(([a], [b]) => a.localeCompare(b))

  // canonical query string（值需 URI 编码）
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
  const timer = setTimeout(() => controller.abort(), 30000)

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
    const block = match[1] || ''
    const key = extractXmlTag(block, 'Key')
    const sizeStr = extractXmlTag(block, 'Size')
    const lastModified = extractXmlTag(block, 'LastModified')
    const etag = extractXmlTag(block, 'ETag')
    if (key) {
      objects.push({
        key: unescapeXml(key),
        size: sizeStr ? parseInt(sizeStr, 10) : 0,
        lastModified: lastModified || '',
        etag: etag?.replace(/"/g, ''),
      })
    }
  }

  // 提取所有 <CommonPrefixes><Prefix>...</Prefix></CommonPrefixes>
  const prefixRegex = /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>/g
  while ((match = prefixRegex.exec(xml)) !== null) {
    if (match[1]) commonPrefixes.push(unescapeXml(match[1]))
  }

  const isTruncated = extractXmlTag(xml, 'IsTruncated') === 'true'
  const continuationToken = extractXmlTag(xml, 'NextContinuationToken') ?? undefined

  return { objects, commonPrefixes, isTruncated, continuationToken }
}

/**
 * 批量删除对象（S3 DeleteMultipleObjects API）。
 *
 * POST /{bucket}?delete，body 为 XML，包含要删除的 <Object><Key>...</Key></Object> 列表。
 * 一次最多 1000 个。带 Content-MD5 头（S3 规范要求）。
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
  // canonical query string: delete=（值为空，S3 规范要求保留 = 号）
  const queryString = 'delete='

  // 构造 XML body
  const body = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Delete>'
    + keys.map(k => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('')
    + '<Quiet>false</Quiet>'
    + '</Delete>'

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

  const contentMd5 = createHash('md5').update(body).digest('base64')

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
        'Content-MD5': contentMd5,
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

/** XML 特殊字符反转义（S3 响应中的 Key/Prefix/Message 等文本会被转义） */
function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

/**
 * 解析 DeleteMultipleObjects 响应。
 *
 * <DeleteResult>
 *   <Deleted><Key>...</Key></Deleted>
 *   <Error><Key>...</Key><Code>...</Code><Message>...</Message></Error>
 * </DeleteResult>
 *
 * 约定：响应中既不在 <Deleted> 也不在 <Error> 的 key，视为删除成功（兜底）。
 */
function parseDeleteResultXml(xml: string, requestedKeys: string[]): DeleteObjectsResult {
  const deleted: string[] = []
  const errors: { key: string, error: string }[] = []

  // 已删除
  const deletedRegex = /<Deleted>\s*<Key>([^<]+)<\/Key>/g
  let match: RegExpExecArray | null
  while ((match = deletedRegex.exec(xml)) !== null) {
    if (match[1]) deleted.push(unescapeXml(match[1]))
  }

  // 失败
  const errorRegex = /<Error>([\s\S]*?)<\/Error>/g
  while ((match = errorRegex.exec(xml)) !== null) {
    const block = match[1] || ''
    const key = extractXmlTag(block, 'Key')
    const code = extractXmlTag(block, 'Code')
    const message = extractXmlTag(block, 'Message')
    if (key) {
      errors.push({ key: unescapeXml(key), error: `${code || 'Error'}: ${message ? unescapeXml(message) : ''}` })
    }
  }

  // 兜底：未在响应中出现的 key 视为删除成功
  const accounted = new Set([...deleted, ...errors.map(e => e.key)])
  for (const k of requestedKeys) {
    if (!accounted.has(k)) deleted.push(k)
  }

  return { deleted, errors }
}

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
    const prefixHasError = allErrors.some(e => e.key === prefix)
    if (prefixHasError) continue

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

/**
 * 获取对象内容流（S3 GetObject）。
 *
 * 返回 fetch 的 Response 和 cleanup 函数。调用方从 res.body 读取 ReadableStream 转发，
 * 流结束后必须调 cleanup() 清理超时定时器，避免连接泄漏。
 * 不缓冲整个文件到内存，支持大文件流式下载。
 *
 * @param rangeHeader  HTTP Range 请求头值（如 "bytes=0-1048575"），透传给 MinIO 支持 Range 请求
 */
export async function getObjectStream(
  instance: MinioInstance,
  bucket: string,
  objectKey: string,
  rangeHeader?: string,
): Promise<{ response: Response | null, error?: string, cleanup?: () => void }> {
  const endpoint = instance.endpoint.replace(/\/+$/, '')
  const host = new URL(endpoint).host
  const encodedKey = encodeObjectKey(objectKey)
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
  // cleanup：清理定时器，调用方在流结束后调
  const cleanup = () => {
    clearTimeout(timer)
  }

  try {
    const headers: Record<string, string> = {
      'Host': host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Authorization': authorization,
    }
    // 透传 Range 请求头（视频预览等场景浏览器会发 Range 请求）
    if (rangeHeader) {
      headers['Range'] = rangeHeader
    }

    const res = await fetch(`${endpoint}${path}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      clearTimeout(timer)
      return { response: null, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
    }

    // 成功：返回 response 和 cleanup，调用方在流结束后调 cleanup
    return { response: res, cleanup }
  }
  catch (e: any) {
    clearTimeout(timer)
    const err = e?.name === 'AbortError' ? '请求超时' : (e?.cause?.code || e?.message || '连接失败')
    return { response: null, error: err }
  }
}
