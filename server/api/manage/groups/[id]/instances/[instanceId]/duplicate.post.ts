import { duplicateInstance } from '#server/utils/store'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const instanceId = getRouterParam(event, 'instanceId')!
  return await duplicateInstance(id, instanceId)
})
