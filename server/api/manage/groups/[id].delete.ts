import { deleteGroup } from '#server/utils/store'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await deleteGroup(id)
  setResponseStatus(event, 204)
  return null
})
