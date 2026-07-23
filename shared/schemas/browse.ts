import * as v from 'valibot'

/** Bucket 信息（S3 ListBuckets 返回） */
export const bucketInfoSchema = v.object({
  name: v.string(),
  createdAt: v.string(),
})
export type BucketInfo = v.InferOutput<typeof bucketInfoSchema>

/** 对象信息（ListObjectsV2 的 Contents 项） */
export const objectInfoSchema = v.object({
  key: v.string(),
  size: v.number(),
  lastModified: v.string(),
  etag: v.optional(v.string()),
})
export type ObjectInfo = v.InferOutput<typeof objectInfoSchema>

/** ListObjectsV2 结果 */
export const listObjectsResultSchema = v.object({
  objects: v.array(objectInfoSchema),
  commonPrefixes: v.array(v.string()),
  isTruncated: v.boolean(),
  continuationToken: v.optional(v.string()),
  error: v.optional(v.string()),
})
export type ListObjectsResult = v.InferOutput<typeof listObjectsResultSchema>

/** 删除结果 */
export const deleteObjectsResultSchema = v.object({
  deleted: v.array(v.string()),
  errors: v.array(
    v.object({
      key: v.string(),
      error: v.string(),
    }),
  ),
})
export type DeleteObjectsResult = v.InferOutput<typeof deleteObjectsResultSchema>

/** 复制/移动请求体 */
export const copyMoveRequestSchema = v.object({
  sourceInstanceId: v.string(),
  sourceBucket: v.string(),
  sourcePrefix: v.string(),
  keys: v.array(v.string()),
  prefixes: v.array(v.string()),
  targetInstanceId: v.string(),
  targetBucket: v.string(),
  targetPrefix: v.string(),
})
export type CopyMoveRequest = v.InferOutput<typeof copyMoveRequestSchema>
