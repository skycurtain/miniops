import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  CreateGroupInput,
  CreateInstanceInput,
  ImportResult,
  InstanceGroup,
  MinioInstance,
  UpdateGroupInput,
  UpdateInstanceInput,
} from '../types'

/**
 * 数据读写层
 *
 * - 所有写操作经过同一个互斥 Promise 链串行化，避免并发写 groups.json 造成损坏。
 * - 读取直接读文件（允许读到稍旧数据，不影响功能）。
 * - 首次访问时自动初始化内置"默认"组。
 * - ID 用 crypto.randomUUID()。
 */

/** 数据文件路径，可通过 DATA_FILE_PATH 环境变量覆盖 */
const DATA_FILE = process.env.DATA_FILE_PATH
  ?? resolve(process.cwd(), 'server/data/groups.json')

const DEFAULT_GROUP: InstanceGroup = {
  id: 'grp-default',
  name: '默认',
  description: '未分组的实例',
  isDefault: true,
  createdAt: '2025-07-15T10:00:00.000Z',
  updatedAt: '2025-07-15T10:00:00.000Z',
  instances: [],
}

// ---------- 互斥锁：把所有写操作串成一个 Promise 链 ----------
let writeChain: Promise<unknown> = Promise.resolve()
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task)
  // 即使 task 失败，也不阻塞后续写操作
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ---------- 底层文件读写 ----------
async function ensureFile(): Promise<void> {
  await fs.mkdir(dirname(DATA_FILE), { recursive: true })
  try {
    await fs.access(DATA_FILE)
  }
  catch {
    await fs.writeFile(DATA_FILE, JSON.stringify([DEFAULT_GROUP], null, 2), 'utf8')
  }
}

async function readRaw(): Promise<InstanceGroup[]> {
  await ensureFile()
  const raw = await fs.readFile(DATA_FILE, 'utf8')
  try {
    const data = JSON.parse(raw) as InstanceGroup[]
    // 保证默认组始终存在且排在最前
    if (!data.some(g => g.id === DEFAULT_GROUP.id)) {
      data.unshift({ ...DEFAULT_GROUP })
    }
    return data
  }
  catch {
    // 文件损坏时回退到默认组，避免整站不可用
    return [{ ...DEFAULT_GROUP }]
  }
}

async function writeRaw(groups: InstanceGroup[]): Promise<void> {
  await ensureFile()
  await fs.writeFile(DATA_FILE, JSON.stringify(groups, null, 2), 'utf8')
}

// ---------- 工具 ----------
function now(): string {
  return new Date().toISOString()
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

function findGroup(groups: InstanceGroup[], id: string): InstanceGroup | undefined {
  return groups.find(g => g.id === id)
}

// ---------- 对外 API ----------

/** 获取所有实例组（含嵌套实例） */
export async function getGroups(): Promise<InstanceGroup[]> {
  return readRaw()
}

/** 获取单个实例组 */
export async function getGroup(id: string): Promise<InstanceGroup | null> {
  const groups = await readRaw()
  return findGroup(groups, id) ?? null
}

/** 新增实例组 */
export async function createGroup(input: CreateGroupInput): Promise<InstanceGroup> {
  return withLock(async () => {
    const groups = await readRaw()
    const group: InstanceGroup = {
      id: genId('grp'),
      name: input.name,
      description: input.description,
      instances: [],
      createdAt: now(),
      updatedAt: now(),
    }
    groups.push(group)
    await writeRaw(groups)
    return group
  })
}

/** 更新实例组（名称、描述） */
export async function updateGroup(id: string, input: UpdateGroupInput): Promise<InstanceGroup> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = findGroup(groups, id)
    if (!group) throw notFound('实例组不存在')
    if (input.name !== undefined) group.name = input.name
    if (input.description !== undefined) group.description = input.description
    group.updatedAt = now()
    await writeRaw(groups)
    return group
  })
}

/** 删除实例组。内置"默认"组不可删除。 */
export async function deleteGroup(id: string): Promise<void> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = findGroup(groups, id)
    if (!group) throw notFound('实例组不存在')
    if (group.isDefault) throw badRequest('内置默认组不可删除')
    const next = groups.filter(g => g.id !== id)
    await writeRaw(next)
  })
}

// ---------- 组内实例管理 ----------

/** 组内新增实例 */
export async function addInstance(groupId: string, input: CreateInstanceInput): Promise<MinioInstance> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = findGroup(groups, groupId)
    if (!group) throw notFound('实例组不存在')
    const instance: MinioInstance = {
      id: genId('inst'),
      groupId,
      name: input.name,
      endpoint: input.endpoint,
      accessKey: input.accessKey,
      secretKey: input.secretKey,
      bucket: input.bucket,
      enabled: input.enabled,
    }
    group.instances.push(instance)
    group.updatedAt = now()
    await writeRaw(groups)
    return instance
  })
}

/** 组内更新实例 */
export async function updateInstance(
  groupId: string,
  instanceId: string,
  input: UpdateInstanceInput,
): Promise<MinioInstance> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = findGroup(groups, groupId)
    if (!group) throw notFound('实例组不存在')
    const instance = group.instances.find(i => i.id === instanceId)
    if (!instance) throw notFound('实例不存在')
    if (input.name !== undefined) instance.name = input.name
    if (input.endpoint !== undefined) instance.endpoint = input.endpoint
    if (input.accessKey !== undefined) instance.accessKey = input.accessKey
    if (input.secretKey !== undefined) instance.secretKey = input.secretKey
    if (input.bucket !== undefined) instance.bucket = input.bucket
    if (input.enabled !== undefined) instance.enabled = input.enabled
    group.updatedAt = now()
    await writeRaw(groups)
    return instance
  })
}

/** 组内删除实例 */
export async function deleteInstance(groupId: string, instanceId: string): Promise<void> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = findGroup(groups, groupId)
    if (!group) throw notFound('实例组不存在')
    group.instances = group.instances.filter(i => i.id !== instanceId)
    group.updatedAt = now()
    await writeRaw(groups)
  })
}

/** 复制实例（在组内创建副本，名称加"(副本)"后缀） */
export async function duplicateInstance(groupId: string, instanceId: string): Promise<MinioInstance> {
  return withLock(async () => {
    const groups = await readRaw()
    const group = findGroup(groups, groupId)
    if (!group) throw notFound('实例组不存在')
    const source = group.instances.find(i => i.id === instanceId)
    if (!source) throw notFound('实例不存在')
    const copy: MinioInstance = {
      ...source,
      id: genId('inst'),
      name: `${source.name}(副本)`,
    }
    // 紧跟源实例之后插入，方便查找
    const idx = group.instances.findIndex(i => i.id === instanceId)
    group.instances.splice(idx + 1, 0, copy)
    group.updatedAt = now()
    await writeRaw(groups)
    return copy
  })
}

// ---------- 导入 / 导出（Phase 2 实现，这里先占位） ----------

/** 导入实例组 JSON（覆盖模式：按 id 匹配，有则更新、无则新增） */
export async function importGroups(incoming: InstanceGroup[]): Promise<ImportResult> {
  return withLock(async () => {
    const groups = await readRaw()
    let added = 0
    let updated = 0
    for (const inc of incoming) {
      const exist = findGroup(groups, inc.id)
      if (exist) {
        exist.name = inc.name
        exist.description = inc.description
        exist.instances = inc.instances ?? []
        exist.updatedAt = now()
        updated++
      }
      else {
        groups.push({
          ...inc,
          instances: inc.instances ?? [],
          createdAt: inc.createdAt ?? now(),
          updatedAt: now(),
        })
        added++
      }
    }
    await writeRaw(groups)
    return { added, updated }
  })
}

/** 导出所有实例组 */
export async function exportGroups(): Promise<InstanceGroup[]> {
  return readRaw()
}

// ---------- 错误工厂（与 h3 对齐） ----------

function notFound(message: string): Error {
  return createError({ statusCode: 404, statusMessage: message })
}

function badRequest(message: string): Error {
  return createError({ statusCode: 400, statusMessage: message })
}
