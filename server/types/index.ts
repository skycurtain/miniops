/**
 * 后端类型定义
 * 与 docs/TECH.md 数据模型保持一致
 */

/** MinIO 实例 */
export interface MinioInstance {
  /** 实例 ID，全局唯一 */
  id: string
  /** 归属的实例组 ID */
  groupId: string
  /** 实例名称，业务语义由用户自由填写，如"人民广场站" */
  name: string
  /** MinIO 端点，如 http://10.24.0.10:9000 */
  endpoint: string
  /** 访问密钥 */
  accessKey: string
  /** 秘密密钥 */
  secretKey: string
  /** 该实例最常用的默认 bucket，如 ndm；分发时可覆盖 */
  bucket?: string
  /** 是否启用 */
  enabled: boolean
}

/** 实例组 */
export interface InstanceGroup {
  /** 组 ID，全局唯一 */
  id: string
  /** 组名称，如"1号线"、"默认" */
  name: string
  /** 组描述 */
  description?: string
  /** 组内实例列表 */
  instances: MinioInstance[]
  /** 是否为系统内置组（如"默认"组），内置组不可删除 */
  isDefault?: boolean
  /** 创建时间（ISO 字符串） */
  createdAt: string
  /** 更新时间（ISO 字符串） */
  updatedAt: string
}

/** 新建实例组时的请求体 */
export type CreateGroupInput = Pick<InstanceGroup, 'name'> & {
  description?: string
}

/** 更新实例组时的请求体 */
export type UpdateGroupInput = Partial<Pick<InstanceGroup, 'name' | 'description'>>

/** 新建实例时的请求体 */
export type CreateInstanceInput = Omit<MinioInstance, 'id' | 'groupId'>

/** 更新实例时的请求体 */
export type UpdateInstanceInput = Partial<CreateInstanceInput>

/** 导入实例组的返回 */
export interface ImportResult {
  added: number
  updated: number
}
