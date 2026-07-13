import { promises as fs } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { inferContentType, sanitizeObjectKey } from './minio'
import type { StoredFile } from '../types'

/**
 * 暂存文件管理
 *
 * - 文件落盘到 UPLOAD_DIR/<id>/<safeName>
 * - 元数据保存在内存 Map<id, StoredFile>（进程重启丢失，但磁盘文件仍在）
 * - 孤儿文件由 cleanup 定时清理（超过 UPLOAD_TTL_HOURS）
 */

/** 暂存目录，可通过 UPLOAD_DIR 环境变量覆盖 */
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ?? resolve(process.cwd(), 'server/data/uploads')

/** 单文件最大字节数，0 表示不限 */
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 0

/** 孤儿文件保留时长（小时） */
const UPLOAD_TTL_HOURS = Number(process.env.UPLOAD_TTL_HOURS) || 24

/** 内存元数据表 */
const fileRegistry = new Map<string, StoredFile>()

/**
 * 暂存一个上传文件。
 *
 * - 生成 uf-<uuid> 作为 id
 * - sanitize 文件名，防止 path traversal
 * - 落盘到 UPLOAD_DIR/<id>/<safeName>
 * - 元数据写入内存 Map
 */
export async function storeUpload(rawName: string, data: Buffer, objectKeyOverride?: string): Promise<StoredFile> {
  const id = `uf-${crypto.randomUUID()}`
  const safeName = sanitizeFileName(rawName)
  const objectKey = objectKeyOverride ? sanitizeObjectKey(objectKeyOverride) : sanitizeObjectKey(rawName)
  const contentType = inferContentType(rawName)
  const dir = join(UPLOAD_DIR, id)
  const storedPath = join(id, safeName)
  const absPath = join(UPLOAD_DIR, storedPath)

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(absPath, data)

  const stored: StoredFile = {
    id,
    name: rawName,
    objectKey,
    size: data.length,
    contentType,
    storedPath,
    uploadedAt: new Date().toISOString(),
  }
  fileRegistry.set(id, stored)
  return stored
}

/**
 * 流式暂存一个上传文件。
 *
 * 与 storeUpload 功能相同，但接受 ReadableStream 而非 Buffer，
 * 避免大文件全量加载进内存。用 pipeline 流式落盘。
 */
export async function storeUploadFromStream(
  rawName: string,
  stream: ReadableStream<Uint8Array>,
  size: number,
  contentTypeOverride?: string,
  objectKeyOverride?: string,
): Promise<StoredFile> {
  const id = `uf-${crypto.randomUUID()}`
  const safeName = sanitizeFileName(rawName)
  const objectKey = objectKeyOverride ? sanitizeObjectKey(objectKeyOverride) : sanitizeObjectKey(rawName)
  const contentType = contentTypeOverride || inferContentType(rawName)
  const dir = join(UPLOAD_DIR, id)
  const storedPath = join(id, safeName)
  const absPath = join(UPLOAD_DIR, storedPath)

  await fs.mkdir(dir, { recursive: true })

  // 流式落盘：ReadableStream -> Node WritableStream
  const nodeStream = stream as unknown as NodeJS.ReadableStream
  await pipeline(nodeStream, createWriteStream(absPath))

  const stored: StoredFile = {
    id,
    name: rawName,
    objectKey,
    size,
    contentType,
    storedPath,
    uploadedAt: new Date().toISOString(),
  }
  fileRegistry.set(id, stored)
  return stored
}

/** 查询暂存文件元数据 */
export function getStoredFile(id: string): StoredFile | null {
  return fileRegistry.get(id) ?? null
}

/**
 * 删除暂存文件（磁盘 + 内存记录）。
 * 容错：元数据不在也尝试删目录。
 */
export async function deleteStoredFile(id: string): Promise<void> {
  const stored = fileRegistry.get(id)
  if (stored) {
    const absPath = join(UPLOAD_DIR, stored.storedPath)
    await fs.rm(absPath, { force: true }).catch(() => {})
    // 删除空目录
    await fs.rm(dirname(absPath), { recursive: false, force: true }).catch(() => {})
    fileRegistry.delete(id)
  }
  else {
    // 元数据不在（可能进程重启），尝试按 id 删目录
    const dir = join(UPLOAD_DIR, id)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 清理过期的孤儿暂存文件。
 *
 * - 扫描 UPLOAD_DIR 下的子目录（每个子目录是一个 uf-xxx 暂存）
 * - 优先用内存 Map 中的 uploadedAt 判定；Map 没有的用目录 mtime 作为 fallback
 * - 超过 UPLOAD_TTL_HOURS 的删除
 *
 * @returns 清理的文件数量
 */
export async function cleanupExpired(): Promise<number> {
  const ttlMs = UPLOAD_TTL_HOURS * 60 * 60 * 1000
  const now = Date.now()
  let cleaned = 0

  let entries: string[]
  try {
    entries = await fs.readdir(UPLOAD_DIR)
  }
  catch {
    // 目录不存在，无需清理
    return 0
  }

  for (const entry of entries) {
    if (!entry.startsWith('uf-')) continue
    const dir = join(UPLOAD_DIR, entry)
    const stored = fileRegistry.get(entry)

    let uploadedAt: number
    if (stored) {
      uploadedAt = new Date(stored.uploadedAt).getTime()
    }
    else {
      // 孤儿文件：用目录 mtime 作为 fallback
      try {
        const stat = await fs.stat(dir)
        uploadedAt = stat.mtimeMs
      }
      catch {
        continue
      }
    }

    if (now - uploadedAt > ttlMs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      if (stored) fileRegistry.delete(entry)
      cleaned++
    }
  }

  return cleaned
}

/**
 * 清洗文件名，防止 path traversal。
 * 只取最后一段（去掉路径），去掉开头点。
 */
function sanitizeFileName(name: string): string {
  // 只取文件名部分（去掉任何路径前缀）
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'unnamed'
  // 去掉开头的点（防隐藏文件 / .. 遍历）
  const cleaned = base.replace(/^\.+/, '')
  return cleaned.length > 0 ? cleaned : 'unnamed'
}
