import { exportGroups } from '#server/utils/store'

export default defineEventHandler(async (event) => {
  const groups = await exportGroups()
  setHeader(event, 'Content-Type', 'application/json')
  setHeader(event, 'Content-Disposition', 'attachment; filename="miniops-groups-export.json"')
  return groups
})
