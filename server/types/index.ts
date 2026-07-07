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

// ---------- 分发相关类型 ----------

/** 暂存的上传文件 */
export interface StoredFile {
  /** 文件 ID */
  id: string
  /** 原始文件名，如 "config.json" */
  name: string
  /** 分发到 MinIO 时的对象 key。单文件 = 文件名；文件夹内文件 = 相对路径，如 "sub/a.json" */
  objectKey: string
  /** 文件大小（字节） */
  size: number
  /** 推断的 MIME 类型 */
  contentType: string
  /** 磁盘相对路径（相对 UPLOAD_DIR），如 "uf-xxx/config.json" */
  storedPath: string
  /** 上传完成时间（ISO 字符串） */
  uploadedAt: string
}

/** 分发任务请求 */
export interface DispatchRequest {
  /** 要分发的文件列表（引用暂存文件的 id，可选覆盖 objectKey） */
  files: { id: string; objectKey?: string }[]
  /** 选中的实例组 ID（展开为组内所有 enabled 实例） */
  groupIds: string[]
  /** 单独勾选的实例 ID（与 groupIds 合并去重） */
  instanceIds: string[]
  /** 分发目标 bucket，全局覆盖 */
  bucket?: string
  /** 按实例指定 bucket，优先级高于 bucket */
  instanceBuckets?: Record<string, string>
  /** 可选目标前缀，分发到 bucket/prefix/ 下 */
  prefix?: string
}

/** 单个文件分发结果 */
export interface DispatchResult {
  groupId: string
  instanceId: string
  instanceName: string
  fileName: string
  status: 'success' | 'failed'
  error?: string
  /** 耗时（毫秒） */
  duration?: number
}

/** 分发任务 */
export interface DispatchTask {
  id: string
  request: DispatchRequest
  status: 'pending' | 'running' | 'done'
  /** 展开后的目标实例列表（去重后） */
  resolvedInstances: MinioInstance[]
  /** 展开后的文件列表（从 request.files 的 id 解析出的 StoredFile） */
  resolvedFiles: StoredFile[]
  results: DispatchResult[]
  createdAt: string
  finishedAt?: string
}

/** SSE 推送的事件 */
export interface DispatchEvent {
  type: 'start' | 'progress' | 'complete'
  taskId: string
  /** progress 事件携带 */
  result?: DispatchResult
  /** complete 事件携带 */
  summary?: {
    total: number
    success: number
    failed: number
  }
}
