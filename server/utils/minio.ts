import type { MinioInstance } from '../types'

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
}

/**
 * 测试单个实例的连通性。
 *
 * 请求 endpoint 的 /minio/health/live 健康检查端点。
 * 该端点无需鉴权，仅验证 MinIO 进程是否存活、网络是否可达。
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
    if (res.status === 200) {
      return { ...base, online: true, latency }
    }
    // 非 200 但有响应，说明进程活着，只是健康检查未通过
    return { ...base, online: false, latency, error: `HTTP ${res.status}` }
  }
  catch (e: any) {
    const latency = Date.now() - start
    const err = e?.name === 'AbortError' ? '请求超时（5s）' : (e?.cause?.code || e?.message || '连接失败')
    return { ...base, online: false, latency, error: err }
  }
}

/**
 * 批量测试组内实例连通性（并发）。
 */
export async function testGroupConnectivity(instances: MinioInstance[]): Promise<ConnectivityResult[]> {
  return Promise.all(instances.map(inst => testConnectivity(inst)))
}

// ---------- AWS SigV4 预签名 URL ----------

import { createHash, createHmac } from 'node:crypto'

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
  const { endpoint, bucket, objectKey, accessKey, secretKey, region, expiresIn } = opts
  const url = new URL(endpoint.replace(/\/+$/, ''))
  const host = url.host

  // 对象路径：/{bucket}/{key}，key 需 URI 编码（但 / 保留）
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
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
    'PUT',
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

    if (!res.ok) {
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
