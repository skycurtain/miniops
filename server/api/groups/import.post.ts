import { importGroups } from '../../utils/store'
import type { InstanceGroup } from '../../types'

/**
 * POST /api/groups/import
 * 导入实例组 JSON（覆盖模式：按 id 匹配，有则更新、无则新增）。
 *
 * 请求体: InstanceGroup[] JSON
 * 响应: { added: number, updated: number }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<InstanceGroup[]>(event)
  if (!Array.isArray(body)) {
    throw createError({ statusCode: 400, statusMessage: '请求体必须是实例组 JSON 数组' })
  }

  // 基本字段校验
  for (const g of body) {
    if (!g.id || !g.name) {
      throw createError({ statusCode: 400, statusMessage: '每个组必须包含 id 和 name 字段' })
    }
  }

  return await importGroups(body)
})
