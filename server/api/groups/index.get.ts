import { getGroups } from '../../utils/store'

/** GET /api/groups — 获取所有实例组（含嵌套实例） */
export default defineEventHandler(async () => {
  return await getGroups()
})
