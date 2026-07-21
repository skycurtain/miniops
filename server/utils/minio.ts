import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3'
import type { MinioInstance, ConnectivityResult } from '#shared/schemas/groups'

// ===== 客户端创建 =====

export function createS3Client(instance: MinioInstance): S3Client {
  return new S3Client({
    endpoint: instance.endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: instance.accessKey,
      secretAccessKey: instance.secretKey,
    },
    forcePathStyle: true,
  })
}

// ===== 连通性测试 =====

export async function testConnectivity(instance: MinioInstance): Promise<ConnectivityResult> {
  const result: ConnectivityResult = {
    instanceId: instance.id,
    instanceName: instance.name,
    endpoint: instance.endpoint,
    online: false,
  }

  // Step 1: health/live（原生 fetch，不走 SDK）
  const healthUrl = `${instance.endpoint}/minio/health/live`
  const healthStart = Date.now()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(healthUrl, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) {
      result.online = false
      result.error = `health/live 返回 ${res.status}`
      return result
    }
    result.online = true
    result.latency = Date.now() - healthStart
  } catch (e) {
    result.online = false
    result.error =
      e instanceof Error
        ? e.name === 'AbortError'
          ? '连接超时（5s）'
          : e.message
        : '网络不可达'
    return result
  }

  // Step 2: listBuckets（走 SDK，验证凭据）
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
  instances: MinioInstance[],
): Promise<ConnectivityResult[]> {
  const enabled = instances.filter((i) => i.enabled)
  return Promise.all(enabled.map((inst) => testConnectivity(inst)))
}
