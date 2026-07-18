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
        enabled: true,
        connectivity: 'online',
        latency: 12,
      },
      {
        id: 'inst-2',
        name: '站B',
        endpoint: 'http://10.0.0.2:9000',
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
        enabled: true,
        connectivity: 'auth-error',
      },
    ],
  },
]
