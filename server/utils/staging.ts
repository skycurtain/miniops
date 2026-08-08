import { randomUUID } from 'node:crypto'
import { mkdir, stat, rm, writeFile } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'

const UPLOAD_DIR = process.env.UPLOAD_DIR || resolve(process.cwd(), 'server/data/uploads')
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 0

export interface StagedFile {
  fileId: string // uf-<uuid>
  objectKey: string
  originalName: string
  size: number
  contentType: string
  diskPath: string // UPLOAD_DIR/uf-<uuid>/<safeName>
}

const stagedFiles = new Map<string, StagedFile>()

/** 从文件名提取安全文件名（只取最后一段，防路径遍历） */
function sanitizeFileName(name: string): string {
  return basename(name) || 'unnamed'
}

/** 暂存一个文件（从 Buffer 写入磁盘） */
export async function stageFile(
  data: Buffer,
  objectKey: string,
  originalName: string,
  contentType: string,
  size: number,
): Promise<StagedFile> {
  // 大小限制检查
  if (MAX_UPLOAD_SIZE > 0 && size > MAX_UPLOAD_SIZE) {
    throw createError({ statusCode: 413, message: `文件大小超过限制 ${MAX_UPLOAD_SIZE} 字节` })
  }

  const fileId = `uf-${randomUUID()}`
  const safeName = sanitizeFileName(originalName)
  const dir = join(UPLOAD_DIR, fileId)
  const diskPath = join(dir, safeName)

  await mkdir(dir, { recursive: true })
  await writeFile(diskPath, data)

  const stagedFile: StagedFile = {
    fileId,
    objectKey,
    originalName,
    size,
    contentType,
    diskPath,
  }

  stagedFiles.set(fileId, stagedFile)
  return stagedFile
}

/** 获取暂存文件 */
export function getStagedFile(fileId: string): StagedFile | undefined {
  return stagedFiles.get(fileId)
}

/** 批量获取暂存文件 */
export function getStagedFiles(fileIds: string[]): StagedFile[] {
  return fileIds
    .map((id) => stagedFiles.get(id))
    .filter((f): f is StagedFile => f !== undefined)
}

/** 删除暂存文件（分发/上传完成后调用） */
export async function removeStagedFile(fileId: string): Promise<void> {
  const file = stagedFiles.get(fileId)
  if (!file) return
  stagedFiles.delete(fileId)
  try {
    await rm(join(UPLOAD_DIR, fileId), { recursive: true, force: true })
  } catch {
    // 忽略删除错误
  }
}

/** 清理孤儿文件（Nitro plugin 定时调用） */
export async function cleanupOrphanedFiles(): Promise<void> {
  const TTL_HOURS = Number(process.env.UPLOAD_TTL_HOURS) || 24
  const now = Date.now()
  const ttlMs = TTL_HOURS * 60 * 60 * 1000

  let entries: string[] = []
  try {
    const dir = await import('node:fs/promises').then((m) => m.readdir(UPLOAD_DIR))
    entries = dir.filter((e) => e.startsWith('uf-'))
  } catch {
    return // 目录不存在
  }

  for (const entry of entries) {
    const dirPath = join(UPLOAD_DIR, entry)
    try {
      const stats = await stat(dirPath)
      if (now - stats.mtimeMs > ttlMs) {
        await rm(dirPath, { recursive: true, force: true })
        // 同时清理内存 Map 中对应的记录
        const fileId = entry
        stagedFiles.delete(fileId)
      }
    } catch {
      // 忽略
    }
  }
}
