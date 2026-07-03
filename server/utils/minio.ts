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
