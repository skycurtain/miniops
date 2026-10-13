import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  InstanceGroup,
  CreateGroupInput,
  UpdateGroupInput,
  S3Instance,
  CreateInstanceInput,
  UpdateInstanceInput,
  ImportResult,
} from '#shared/schemas/groups'

const DATA_FILE = path.resolve(process.cwd(), 'server/data/groups.json')

// ===== 互斥锁 =====

let writeChain: Promise<unknown> = Promise.resolve()

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeChain.then(fn)
  writeChain = result.catch(() => {})
  return result as Promise<T>
}

// ===== 默认组初始化 =====

function createDefaultGroup(): InstanceGroup {
  const now = new Date().toISOString()
  return {
    id: 'grp-default',
    name: '默认',
    description: '',
    instances: [],
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  }
}

// ===== 文件读写 =====

async function ensureFile(): Promise<void> {
  try {
    await fs.access(DATA_FILE)
  } catch {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true })
    await fs.writeFile(DATA_FILE, JSON.stringify([createDefaultGroup()], null, 2), 'utf-8')
  }
}

async function readRaw(): Promise<InstanceGroup[]> {
  await ensureFile()
  const content = await fs.readFile(DATA_FILE, 'utf-8')
  return JSON.parse(content) as InstanceGroup[]
}

async function writeRaw(groups: InstanceGroup[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(groups, null, 2), 'utf-8')
}

// ===== ID 生成 =====

function generateGroupId(): string {
  return `grp-${randomUUID()}`
}

function generateInstanceId(): string {
  return `inst-${randomUUID()}`
}

// ===== 读操作 =====

export async function getGroups(): Promise<InstanceGroup[]> {
  return readRaw()
}

export async function getGroup(id: string): Promise<InstanceGroup | null> {
  const groups = await readRaw()
  return groups.find((g) => g.id === id) ?? null
}

// ===== 分组写操作 =====

export async function createGroup(input: CreateGroupInput): Promise<InstanceGroup> {
  return withLock(async () => {
    const groups = await readRaw()
    const now = new Date().toISOString()
    const group: InstanceGroup = {
      id: generateGroupId(),
      name: input.name,
      description: input.description ?? '',
      instances: [],
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    }
    groups.push(group)
    await writeRaw(groups)
    return group
  })
}

export async function updateGroup(
  id: string,
  input: UpdateGroupInput,
): Promise<InstanceGroup | null> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = groups.find((g) => g.id === id)
    if (!group) return null
    if (input.name !== undefined) group.name = input.name
    if (input.description !== undefined) group.description = input.description
    group.updatedAt = new Date().toISOString()
    await writeRaw(groups)
    return group
  })
}

export async function deleteGroup(id: string): Promise<void> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = groups.find((g) => g.id === id)
    if (!group) throw createError({ statusCode: 404, message: '分组不存在' })
    if (group.isDefault) throw createError({ statusCode: 400, message: '默认分组不可删除' })
    const filtered = groups.filter((g) => g.id !== id)
    await writeRaw(filtered)
  })
}

// ===== 实例写操作 =====

export async function addInstance(
  groupId: string,
  input: CreateInstanceInput,
): Promise<S3Instance> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = groups.find((g) => g.id === groupId)
    if (!group) throw createError({ statusCode: 404, message: '分组不存在' })
    const instance: S3Instance = {
      id: generateInstanceId(),
      groupId,
      ...input,
    }
    group.instances.push(instance)
    group.updatedAt = new Date().toISOString()
    await writeRaw(groups)
    return instance
  })
}

export async function updateInstance(
  groupId: string,
  instanceId: string,
  input: UpdateInstanceInput,
): Promise<S3Instance | null> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = groups.find((g) => g.id === groupId)
    if (!group) throw createError({ statusCode: 404, message: '分组不存在' })
    const instance = group.instances.find((i) => i.id === instanceId)
    if (!instance) throw createError({ statusCode: 404, message: '实例不存在' })
    Object.assign(instance, input)
    group.updatedAt = new Date().toISOString()
    await writeRaw(groups)
    return instance
  })
}

export async function deleteInstance(groupId: string, instanceId: string): Promise<void> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = groups.find((g) => g.id === groupId)
    if (!group) throw createError({ statusCode: 404, message: '分组不存在' })
    group.instances = group.instances.filter((i) => i.id !== instanceId)
    group.updatedAt = new Date().toISOString()
    await writeRaw(groups)
  })
}

export async function duplicateInstance(
  groupId: string,
  instanceId: string,
): Promise<S3Instance> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = groups.find((g) => g.id === groupId)
    if (!group) throw createError({ statusCode: 404, message: '分组不存在' })
    const source = group.instances.find((i) => i.id === instanceId)
    if (!source) throw createError({ statusCode: 404, message: '实例不存在' })
    const copy: S3Instance = {
      ...source,
      id: generateInstanceId(),
      name: `${source.name}(副本)`,
    }
    const idx = group.instances.findIndex((i) => i.id === instanceId)
    group.instances.splice(idx + 1, 0, copy)
    group.updatedAt = new Date().toISOString()
    await writeRaw(groups)
    return copy
  })
}

// ===== 导入/导出 =====

export async function exportGroups(): Promise<InstanceGroup[]> {
  return readRaw()
}

export async function importGroups(input: InstanceGroup[]): Promise<ImportResult> {
  return withLock(async () => {
    const groups = await readRaw()
    let added = 0
    let updated = 0

    for (const imp of input) {
      const existing = groups.find((g) => g.id === imp.id)
      if (existing) {
        existing.name = imp.name
        existing.description = imp.description ?? ''
        existing.instances = imp.instances.map((inst) => ({
          ...inst,
          groupId: existing.id,
        }))
        existing.updatedAt = new Date().toISOString()
        updated++
      } else {
        groups.push({
          ...imp,
          instances: imp.instances.map((inst) => ({
            ...inst,
            groupId: imp.id,
          })),
          createdAt: imp.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        added++
      }
    }

    await writeRaw(groups)
    return { added, updated }
  })
}
