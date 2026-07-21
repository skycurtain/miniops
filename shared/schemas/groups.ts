import * as v from 'valibot'

/** MinIO 实例 */
export const minioInstanceSchema = v.object({
  id: v.string(),
  groupId: v.string(),
  name: v.string(),
  endpoint: v.string(),
  accessKey: v.string(),
  secretKey: v.string(),
  enabled: v.boolean(),
})
export type MinioInstance = v.InferOutput<typeof minioInstanceSchema>

/** 实例组 */
export const instanceGroupSchema = v.object({
  id: v.string(),
  name: v.string(),
  description: v.optional(v.string()),
  instances: v.array(minioInstanceSchema),
  isDefault: v.optional(v.boolean()),
  createdAt: v.string(),
  updatedAt: v.string(),
})
export type InstanceGroup = v.InferOutput<typeof instanceGroupSchema>

/** 新建分组请求体 */
export const createGroupSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1, '名称不能为空')),
  description: v.optional(v.string()),
})
export type CreateGroupInput = v.InferOutput<typeof createGroupSchema>

/** 更新分组请求体（所有字段可选） */
export const updateGroupSchema = v.partial(createGroupSchema)
export type UpdateGroupInput = v.InferOutput<typeof updateGroupSchema>

/** 新建实例请求体 */
export const createInstanceSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1, '实例名称不能为空')),
  endpoint: v.pipe(
    v.string(),
    v.minLength(1, 'endpoint 不能为空'),
    v.url('endpoint 必须是合法的 URL'),
    v.regex(/^https?:\/\//, 'endpoint 必须以 http:// 或 https:// 开头'),
  ),
  accessKey: v.pipe(v.string(), v.minLength(1, 'accessKey 不能为空')),
  secretKey: v.pipe(v.string(), v.minLength(1, 'secretKey 不能为空')),
  enabled: v.boolean(),
})
export type CreateInstanceInput = v.InferOutput<typeof createInstanceSchema>

/** 更新实例请求体（所有字段可选） */
export const updateInstanceSchema = v.partial(createInstanceSchema)
export type UpdateInstanceInput = v.InferOutput<typeof updateInstanceSchema>

/** 导入结果 */
export const importResultSchema = v.object({
  added: v.number(),
  updated: v.number(),
})
export type ImportResult = v.InferOutput<typeof importResultSchema>

/** 连通性测试结果 */
export const connectivityResultSchema = v.object({
  instanceId: v.string(),
  instanceName: v.string(),
  endpoint: v.string(),
  online: v.boolean(),
  latency: v.optional(v.number()),
  error: v.optional(v.string()),
  authValid: v.optional(v.boolean()),
  authError: v.optional(v.string()),
})
export type ConnectivityResult = v.InferOutput<typeof connectivityResultSchema>
