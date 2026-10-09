import { randomUUID } from 'node:crypto'
import { mkdir, stat, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve, basename } from 'node:path'

import type { StagedFileListItem } from '#shared/schemas/task'

const UPLOAD_DIR = process.env.UPLOAD_DIR || resolve(process.cwd(), 'server/data/uploads')
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 0
const META_NAME = 'meta.json'

export interface StagedFile {
  fileId: string // uf-<uuid>
  objectKey: string
  originalName: string
  size: number
  contentType: string
  diskPath: string // UPLOAD_DIR/uf-<uuid>/<safeName>
  stagedAt: string // ISO
}

const stagedFiles = new Map<string, StagedFile>()

/** 从文件名提取安全文件名（只取最后一段，防路径遍历） */
function sanitizeFileName(name: string): string {
  return basename(name) || 'unnamed'
}

function toListItem(f: StagedFile): StagedFileListItem {
  return {
    fileId: f.fileId,
    objectKey: f.objectKey,
    originalName: f.originalName,
    size: f.size,
    contentType: f.contentType,
    stagedAt: f.stagedAt,
  }
}

/** 暂存一个文件（从 Buffer 写入磁盘 + 持久化 meta.json，进程重启后仍可列出） */
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
    stagedAt: new Date().toISOString(),
  }

  await writeFile(
    join(dir, META_NAME),
    JSON.stringify({
      fileId,
      objectKey,
      originalName,
      size,
      contentType,
      stagedAt: stagedFile.stagedAt,
    }),
  )

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

/** 从磁盘 meta.json 读回一条记录（进程重启后 Map 丢失时使用） */
async function loadStagedFromDisk(fileId: string): Promise<StagedFile | undefined> {
  const dir = join(UPLOAD_DIR, fileId)
  try {
    const raw = await readFile(join(dir, META_NAME), 'utf8')
    const meta = JSON.parse(raw) as Omit<StagedFile, 'diskPath'>
    // diskPath 按 meta 中的 originalName 重建
    const diskPath = join(dir, sanitizeFileName(meta.originalName))
    return { ...meta, diskPath }
  } catch {
    return undefined
  }
}

/** 列出全部暂存文件（内存 Map + 磁盘兜底） */
export async function listStagedFiles(): Promise<StagedFileListItem[]> {
  const items = new Map<string, StagedFileListItem>()
  for (const f of stagedFiles.values()) {
    items.set(f.fileId, toListItem(f))
  }

  let entries: string[] = []
  try {
    entries = (await readdir(UPLOAD_DIR)).filter((e) => e.startsWith('uf-'))
  } catch {
    // 目录不存在
  }

  for (const entry of entries) {
    if (items.has(entry)) continue
    const fromDisk = await loadStagedFromDisk(entry)
    if (fromDisk) {
      items.set(entry, toListItem(fromDisk))
    } else {
      // 无 meta 的孤儿目录：尽量用目录 mtime / 文件大小兜底展示
      try {
        const dirPath = join(UPLOAD_DIR, entry)
        const stats = await stat(dirPath)
        items.set(entry, {
          fileId: entry,
          objectKey: '',
          originalName: '(未知)',
          size: 0,
          contentType: '',
          stagedAt: new Date(stats.mtimeMs).toISOString(),
        })
      } catch {
        // 忽略
      }
    }
  }

  return [...items.values()].sort((a, b) => b.stagedAt.localeCompare(a.stagedAt))
}

/**
 * 删除暂存文件。
 * 无论 Map 是否有记录都删磁盘目录，保证重启后的孤儿也可清。
 */
export async function removeStagedFile(fileId: string): Promise<void> {
  stagedFiles.delete(fileId)
  // 只接受 uf- 前缀，防路径遍历
  if (!fileId.startsWith('uf-') || fileId.includes('/') || fileId.includes('\\')) return
  try {
    await rm(join(UPLOAD_DIR, fileId), { recursive: true, force: true })
  } catch {
    // 忽略删除错误
  }
}

/** 批量删除，返回实际删除数量 */
export async function removeStagedFiles(fileIds: string[]): Promise<number> {
  let n = 0
  for (const id of fileIds) {
    await removeStagedFile(id)
    n++
  }
  return n
}

/** 清理孤儿文件（Nitro plugin 定时调用） */
export async function cleanupOrphanedFiles(): Promise<void> {
  const TTL_HOURS = Number(process.env.UPLOAD_TTL_HOURS) || 24
  const now = Date.now()
  const ttlMs = TTL_HOURS * 60 * 60 * 1000

  let entries: string[]
  try {
    entries = (await readdir(UPLOAD_DIR)).filter((e) => e.startsWith('uf-'))
  } catch {
    return // 目录不存在
  }

  for (const entry of entries) {
    const dirPath = join(UPLOAD_DIR, entry)
    try {
      const stats = await stat(dirPath)
      if (now - stats.mtimeMs > ttlMs) {
        await rm(dirPath, { recursive: true, force: true })
        stagedFiles.delete(entry)
      }
    } catch {
      // 忽略
    }
  }
}
