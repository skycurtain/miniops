import { deleteInstance } from '#server/utils/store'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const instanceId = getRouterParam(event, 'instanceId')!
  await deleteInstance(id, instanceId)
  setResponseStatus(event, 204)
  return null
})
