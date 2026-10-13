import { getGroups } from '#server/utils/store'
import { listObjects, getObjectStream } from '#server/utils/s3'
import { ZipArchive } from 'archiver'
import type { S3Instance } from '#shared/schemas/groups'

/** 批量 ZIP 打包的对象数量上限 */
const BATCH_DOWNLOAD_COUNT_LIMIT = Number(process.env.DOWNLOAD_MAX_OBJECTS) || 1000

/**
 * POST /api/browse/objects/download-batch
 * 批量 ZIP 打包下载，支持混合选中对象和文件夹。
 *
 * 请求体: { instanceId, bucket, keys: string[], prefixes?: string[] }
 * 响应: application/zip 流式下载
 *
 * 单个对象获取失败时在 ZIP 内生成 .ERROR.txt 标记，不中断打包。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{
    instanceId: string
    bucket: string
    keys: string[]
    prefixes?: string[]
  }>(event)

  if (!body?.instanceId) {
    throw createError({ statusCode: 400, message: '缺少 instanceId' })
  }
  if (!body?.bucket) {
    throw createError({ statusCode: 400, message: '缺少 bucket' })
  }
  if (!body?.keys?.length && !body?.prefixes?.length) {
    throw createError({ statusCode: 400, message: '缺少 keys 或 prefixes' })
  }

  // 从 store 查出实例
  const allGroups = await getGroups()
  let instance: S3Instance | undefined
  for (const g of allGroups) {
    instance = g.instances.find((i) => i.id === body.instanceId)
    if (instance) break
  }
  if (!instance) {
    throw createError({ statusCode: 404, message: '未找到指定实例' })
  }

  // 1. 收集所有要打包的对象 key（keys + 递归列出 prefixes，去重）
  const allKeys = new Set<string>(body.keys ?? [])

  for (const prefix of body.prefixes ?? []) {
    let token: string | undefined
    do {
      const result = await listObjects(instance, body.bucket, prefix, '', token)
      if (result.error) {
        throw createError({ statusCode: 502, message: `列出文件夹失败: ${result.error}` })
      }
      for (const o of result.objects) {
        allKeys.add(o.key)
      }
      token = result.isTruncated ? result.continuationToken : undefined
    } while (token)
  }

  // 2. 检查数量上限
  if (allKeys.size > BATCH_DOWNLOAD_COUNT_LIMIT) {
    throw createError({
      statusCode: 400,
      message: `选中内容过多（${allKeys.size} 个对象 > ${BATCH_DOWNLOAD_COUNT_LIMIT}），请缩小范围`,
    })
  }

  // 3. 创建 ZIP 流
  const archive = new ZipArchive({ zlib: { level: 1 } })
  const zipName = `miniops-download-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`

  setResponseHeader(event, 'Content-Type', 'application/zip')
  setResponseHeader(event, 'Content-Disposition', `attachment; filename="${zipName}"`)

  // pipe archiver 到 HTTP 响应
  archive.pipe(event.node.res)

  // 4. 逐个 GetObject -> append 到 ZIP
  const timer = setTimeout(() => archive.abort(), 300000) // 5 分钟超时

  try {
    for (const key of allKeys) {
      const { stream, error } = await getObjectStream(instance, body.bucket, key)
      if (error || !stream) {
        archive.append(`下载失败: ${error}\n`, { name: `${key}.ERROR.txt` })
        continue
      }
      // ZIP 内路径用对象 key（保持目录结构）
      archive.append(stream, { name: key })
    }
    await archive.finalize()
  } catch (e: unknown) {
    const err = e as { message?: string }
    throw createError({ statusCode: 502, message: err?.message || '打包失败' })
  } finally {
    clearTimeout(timer)
  }
})
