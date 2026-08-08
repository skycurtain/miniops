import { createTask } from '#server/utils/task-manager'
import { createDispatchExecutor } from '#server/utils/executors/dispatch'

/**
 * POST /api/dispatch
 * 提交分发任务。
 *
 * 请求:
 *   files: { fileId: string, objectKey: string }[]
 *   targets: { instanceId: string, bucket: string }[]
 *   prefix: string
 *
 * 响应: { taskId: string }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    files: { fileId: string; objectKey: string }[]
    targets: { instanceId: string; bucket: string }[]
    prefix: string
  }>(event)

  if (!body?.files?.length) {
    throw createError({ statusCode: 400, message: '缺少文件列表' })
  }
  if (!body?.targets?.length) {
    throw createError({ statusCode: 400, message: '缺少目标实例' })
  }

  const executor = createDispatchExecutor(body.files, body.targets, body.prefix || '')

  const targetDesc = body.targets.length === 1
    ? `${body.targets[0]!.instanceId}/${body.targets[0]!.bucket}`
    : `${body.targets.length} 个实例`

  const taskId = createTask(
    'dispatch',
    {
      type: 'dispatch',
      label: `分发 ${body.files.length} 个文件 -> ${targetDesc}`,
      detail: body.prefix ? `前缀: ${body.prefix}` : undefined,
    },
    executor,
    {
      files: body.files,
      targets: body.targets,
      prefix: body.prefix || '',
    },
  )

  return { taskId }
})
