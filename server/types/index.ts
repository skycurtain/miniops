// Re-export 共享类型和 schema，供 server 端使用
export type {
  S3Instance,
  InstanceGroup,
  CreateGroupInput,
  UpdateGroupInput,
  CreateInstanceInput,
  UpdateInstanceInput,
  ImportResult,
  ConnectivityResult,
} from '#shared/schemas/groups'

export {
  s3InstanceSchema,
  instanceGroupSchema,
  createGroupSchema,
  updateGroupSchema,
  createInstanceSchema,
  updateInstanceSchema,
  importResultSchema,
  connectivityResultSchema,
} from '#shared/schemas/groups'
