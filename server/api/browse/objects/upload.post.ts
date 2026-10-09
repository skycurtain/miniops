import { getGroups } from '#server/utils/store'
import { createTask } from '#server/utils/task-manager'
import { createUploadExecutor } from '#server/utils/executors/upload'
import { getStagedFiles } from '#server/utils/staging'
import { sanitizeObjectKey } from '#server/utils/minio'
import type { MinioInstance } from '#shared/schemas/groups'
import type { TaskDescription } from '#shared/schemas/task'

/**
 * POST /api/browse/objects/upload
 * 提交上传任务（文件已在暂存阶段落盘，见 stage.post.ts）。
 *
 * 请求体（JSON）:
 *   - files: { fileId: string; objectKey: string }[]  // 暂存 fileId + 相对路径
 *   - instanceId: string
 *   - bucket: string
 *   - prefix: string（目标前缀，留空=根）
 *
 * 响应: { taskId: string }
 *
 * 任务由 TaskManager 异步执行，与 SSE 连接解绑，
 * 支持后台运行和断线重连（通用任务架构）。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    files?: { fileId: string; objectKey: string }[]
    instanceId?: string
    bucket?: string
    prefix?: string
  }>(event)

  if (!body?.files?.length) {
    throw createError({ statusCode: 400, message: '缺少文件列表' })
  }
  if (!body.instanceId) {
    throw createError({ statusCode: 400, message: '缺少 instanceId' })
  }
  if (!body.bucket) {
    throw createError({ statusCode: 400, message: '缺少 bucket' })
  }

  // 从 store 查出实例
  const allGroups = await getGroups()
  let instance: MinioInstance | undefined
  for (const g of allGroups) {
    instance = g.instances.find((i) => i.id === body.instanceId)
    if (instance) break
  }
  if (!instance) {
    throw createError({ statusCode: 404, message: '未找到指定实例' })
  }

  // 校验所有 fileId 均已暂存
  const stagedFiles = getStagedFiles(body.files.map(f => f.fileId))
  if (stagedFiles.length !== body.files.length) {
    throw createError({ statusCode: 400, message: '部分文件未暂存或已过期，请重新上传' })
  }

  const prefix = body.prefix ? sanitizeObjectKey(body.prefix) : ''

  // 构造任务描述
  const description: TaskDescription = {
    type: 'upload',
    label: `上传 ${body.files.length} 个文件`,
    detail: `${instance.name}/${body.bucket}${prefix ? `/${prefix}` : ''}`,
  }

  // 创建执行器（工厂函数，闭包捕获参数）
  const executor = createUploadExecutor({
    files: body.files,
    instance,
    bucket: body.bucket,
    prefix,
  })

  // 创建任务，返回 taskId
  const taskId = createTask('upload', description, executor)

  return { taskId }
})
