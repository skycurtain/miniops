/**
 * Mock 数据 - 实例管理原型
 *
 * 原型专用 mock 数据，不对接真实 API。
 * 后续真实实现时，proto 原型保留，逻辑迁移到正式页面。
 */

export interface MockInstance {
  id: string
  name: string
  endpoint: string
  accessKey?: string
  secretKey?: string
  enabled: boolean
  connectivity?: 'online' | 'offline' | 'auth-error' | 'testing' | null
  latency?: number
}

export interface MockGroup {
  id: string
  name: string
  description?: string
  isDefault?: boolean
  instances: MockInstance[]
}

export const mockGroups: MockGroup[] = [
  {
    id: 'grp-default',
    name: '默认',
    isDefault: true,
    instances: [],
  },
  {
    id: 'grp-1',
    name: '分组 X',
    description: '测试环境',
    instances: [
      {
        id: 'inst-1',
        name: '站A',
        endpoint: 'http://10.0.0.1:9000',
        accessKey: 'admin',
        secretKey: 'admin12345',
        enabled: true,
        connectivity: 'online',
        latency: 12,
      },
      {
        id: 'inst-2',
        name: '站B',
        endpoint: 'http://10.0.0.2:9000',
        accessKey: 'minioadmin',
        secretKey: 'minioadmin',
        enabled: false,
        connectivity: 'offline',
      },
    ],
  },
  {
    id: 'grp-2',
    name: '分组 Y',
    description: '生产环境',
    instances: [
      {
        id: 'inst-3',
        name: '站C',
        endpoint: 'http://10.0.0.3:9000',
        accessKey: 'prod-minio',
        secretKey: 'prod-secret-2025',
        enabled: true,
        connectivity: 'auth-error',
      },
    ],
  },
  ...Array.from({ length: 25 }, (_, i) => ({
    id: `grp-extra-${i + 1}`,
    name: `业务分组-${i + 1}`,
    description: `第 ${i + 1} 个业务分组`,
    instances: Array.from({ length: Math.min((i + 1) * 3, 20) }, (_, j) => ({
      id: `inst-extra-${i + 1}-${j + 1}`,
      name: `节点${String.fromCharCode(68 + j)}`,
      endpoint: `http://10.0.${i + 1}.${j + 10}:9000`,
      accessKey: `user-${i + 1}-${j + 1}`,
      secretKey: `pass-${i + 1}-${j + 1}`,
      enabled: j % 3 !== 0,
      connectivity: (['online', 'offline', 'auth-error', 'online'] as const)[j % 4],
      latency: j % 3 === 0 ? Math.floor(Math.random() * 20) + 5 : undefined,
    })),
  })),
]
