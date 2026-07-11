import type { InstanceGroup } from '../../types'

/**
 * GET /api/groups/template
 * 下载配置模板 JSON（展示完整的组+实例结构，作为导入参考或批量创建起点）。
 */
export default defineEventHandler((event) => {
  const template: InstanceGroup[] = [
    {
      id: 'grp-a',
      name: '节点组 A',
      description: '节点组 A 全部实例',
      isDefault: false,
      createdAt: '2025-07-15T10:00:00.000Z',
      updatedAt: '2025-07-15T10:00:00.000Z',
      instances: [
        {
          id: 'inst-001',
          groupId: 'grp-east',
          name: '实例 1',
          endpoint: 'http://10.24.0.10:9000',
          accessKey: 'minioadmin',
          secretKey: 'minioadmin',
          enabled: true,
        },
        {
          id: 'inst-002',
          groupId: 'grp-east',
          name: '实例 2',
          endpoint: 'http://10.24.0.11:9000',
          accessKey: 'minioadmin',
          secretKey: 'minioadmin',
          enabled: true,
        },
      ],
    },
    {
      id: 'grp-b',
      name: '节点组 B',
      description: '节点组 B 全部实例（示例：禁用状态的实例）',
      isDefault: false,
      createdAt: '2025-07-15T10:00:00.000Z',
      updatedAt: '2025-07-15T10:00:00.000Z',
      instances: [
        {
          id: 'inst-003',
          groupId: 'grp-west',
          name: '实例 3',
          endpoint: 'http://10.24.0.20:9000',
          accessKey: 'minioadmin',
          secretKey: 'minioadmin',
          enabled: false,
        },
      ],
    },
  ]

  setHeader(event, 'Content-Type', 'application/json')
  setHeader(event, 'Content-Disposition', 'attachment; filename="miniops-groups-template.json"')
  return template
})
