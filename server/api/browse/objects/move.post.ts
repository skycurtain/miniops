import { getGroups } from '#server/utils/store'
import { createTask } from '#server/utils/task-manager'
import { createMoveExecutor } from '#server/utils/executors/move'
import type { MinioInstance } from '#shared/schemas/groups'
import type { TaskDescription } from '#shared/schemas/task'

/**
 * POST /api/browse/objects/move
 * 移动对象到另一个实例/bucket（复制 + 删除源对象）。
 *
 * 改造后：提交即返回 taskId，进度通过通用 SSE 端点订阅。
 * 后端任务与连接解绑，支持后台运行和断线重连。
 *
 * 响应: { taskId: string }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    sourceInstanceId: string
    sourceBucket: string
    sourcePrefix: string
    keys: string[]
    prefixes: string[]
    targetInstanceId: string
    targetBucket: string
    targetPrefix: string
  }>(event)

  if (!body?.sourceInstanceId || !body?.targetInstanceId) {
    throw createError({ statusCode: 400, message: '缺少源/目标实例 ID' })
  }
  if (!body?.sourceBucket || !body?.targetBucket) {
    throw createError({ statusCode: 400, message: '缺少源/目标 bucket' })
  }

  // 查找源/目标实例
  const allGroups = await getGroups()
  const findInstance = (id: string): MinioInstance | undefined => {
    for (const g of allGroups) {
      const inst = g.instances.find((i) => i.id === id)
      if (inst) return inst
    }
    return undefined
  }

  const sourceInstance = findInstance(body.sourceInstanceId)
  const targetInstance = findInstance(body.targetInstanceId)
  if (!sourceInstance) {
    throw createError({ statusCode: 404, message: '未找到源实例' })
  }
  if (!targetInstance) {
    throw createError({ statusCode: 404, message: '未找到目标实例' })
  }

  // 构造任务描述
  const objectCount = body.keys.length + body.prefixes.length
  const description: TaskDescription = {
    type: 'move',
    label: `移动 ${objectCount} 个对象`,
    detail: `${sourceInstance.name}/${body.sourceBucket} -> ${targetInstance.name}/${body.targetBucket}`,
  }

  // 创建执行器（工厂函数，闭包捕获参数）
  const executor = createMoveExecutor({
    sourceInstance,
    sourceBucket: body.sourceBucket,
    sourcePrefix: body.sourcePrefix,
    keys: body.keys,
    prefixes: body.prefixes,
    targetInstance,
    targetBucket: body.targetBucket,
    targetPrefix: body.targetPrefix,
  })

  // 创建任务，返回 taskId
  const taskId = createTask('move', description, executor)

  return { taskId }
})
