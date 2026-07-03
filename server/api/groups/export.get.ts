import { exportGroups } from '../../utils/store'

/**
 * GET /api/groups/export
 * 导出当前所有实例组为 JSON 文件（带 Content-Disposition 附件头）。
 */
export default defineEventHandler(async (event) => {
  const groups = await exportGroups()
  setHeader(event, 'Content-Type', 'application/json')
  setHeader(event, 'Content-Disposition', 'attachment; filename="miniops-groups-export.json"')
  return groups
})
