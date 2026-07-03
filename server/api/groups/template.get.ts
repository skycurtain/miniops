import type { InstanceGroup } from '../../types'

/**
 * GET /api/groups/template
 * 下载配置模板 JSON（展示完整的组+实例结构，作为导入参考或批量创建起点）。
 */
export default defineEventHandler((event) => {
  const template: InstanceGroup[] = [
    {
      id: 'grp-line-1',
      name: '1号线',
      description: '1号线全部车站',
      isDefault: false,
      createdAt: '2025-07-15T10:00:00.000Z',
      updatedAt: '2025-07-15T10:00:00.000Z',
      instances: [
        {
          id: 'inst-001',
          groupId: 'grp-line-1',
          name: '人民广场站',
          endpoint: 'http://10.24.0.10:9000',
          accessKey: 'minioadmin',
          secretKey: 'minioadmin',
          bucket: 'ndm',
          enabled: true,
        },
        {
          id: 'inst-002',
          groupId: 'grp-line-1',
          name: '南京东路站',
          endpoint: 'http://10.24.0.11:9000',
          accessKey: 'minioadmin',
          secretKey: 'minioadmin',
          bucket: 'ndm',
          enabled: true,
        },
      ],
    },
    {
      id: 'grp-line-2',
      name: '2号线',
      description: '2号线全部车站（示例：禁用状态的实例）',
      isDefault: false,
      createdAt: '2025-07-15T10:00:00.000Z',
      updatedAt: '2025-07-15T10:00:00.000Z',
      instances: [
        {
          id: 'inst-003',
          groupId: 'grp-line-2',
          name: '静安寺站',
          endpoint: 'http://10.24.0.20:9000',
          accessKey: 'minioadmin',
          secretKey: 'minioadmin',
          bucket: 'ndm',
          enabled: false,
        },
      ],
    },
  ]

  setHeader(event, 'Content-Type', 'application/json')
  setHeader(event, 'Content-Disposition', 'attachment; filename="miniops-groups-template.json"')
  return template
})
