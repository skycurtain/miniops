// Re-export 共享类型和 schema，供 server 端使用
export type {
  MinioInstance,
  InstanceGroup,
  CreateGroupInput,
  UpdateGroupInput,
  CreateInstanceInput,
  UpdateInstanceInput,
  ImportResult,
  ConnectivityResult,
} from '#shared/schemas/groups'

export {
  minioInstanceSchema,
  instanceGroupSchema,
  createGroupSchema,
  updateGroupSchema,
  createInstanceSchema,
  updateInstanceSchema,
  importResultSchema,
  connectivityResultSchema,
} from '#shared/schemas/groups'
