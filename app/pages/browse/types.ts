import type { ObjectInfo, BucketInfo } from '#shared/schemas/browse'

export type RowTarget = { type: 'object' | 'folder'; key: string }

export interface BrowseTab {
  instanceId: string
  instanceName: string
  buckets: BucketInfo[]
  bucketsLoading: boolean
  bucketError: string
  selectedBucket: string
  objects: ObjectInfo[]
  commonPrefixes: string[]
  currentPrefix: string
  objectsLoading: boolean
  objectsError: string
  hasMore: boolean
  loadingMore: boolean
  continuationToken?: string
  selectedKeys: Set<string>
  selectedPrefixes: Set<string>
}

/** Table 行数据：文件夹和对象合并 */
export interface BrowseTableRow {
  type: 'folder' | 'object'
  key: string
  name: string
  size?: number
  lastModified?: string
}
