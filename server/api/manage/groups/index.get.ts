import { getGroups } from '#server/utils/store'

export default defineEventHandler(async () => {
  return await getGroups()
})
