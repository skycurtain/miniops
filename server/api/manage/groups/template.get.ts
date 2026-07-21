export default defineEventHandler((event) => {
  const template = [
    {
      id: 'grp-example',
      name: '示例分组',
      description: '这是一个示例分组',
      isDefault: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      instances: [
        {
          id: 'inst-example',
          groupId: 'grp-example',
          name: '示例实例',
          endpoint: 'http://127.0.0.1:9000',
          accessKey: 'minioadmin',
          secretKey: 'minioadmin',
          enabled: true,
        },
      ],
    },
  ]
  setHeader(event, 'Content-Type', 'application/json')
  setHeader(event, 'Content-Disposition', 'attachment; filename="miniops-groups-template.json"')
  return template
})
