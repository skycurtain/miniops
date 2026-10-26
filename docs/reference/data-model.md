# 数据模型（权威）

持久化与前后端共享类型的唯一来源。

## 持久化：`server/data/groups.json`

结构为 `InstanceGroup[]`。进程首次访问自动初始化，含内置**默认分组**（`isDefault: true`，不可删除）。写入使用互斥 Promise 链串行。

### InstanceGroup

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 分组 id |
| `name` | string | 分组名称 |
| `description` | string? | 描述 |
| `instances` | S3Instance[] | 组内实例 |
| `isDefault` | boolean? | 内置默认组标记 |
| `createdAt` | string | ISO 时间 |
| `updatedAt` | string | ISO 时间 |

### S3Instance

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 实例 id |
| `groupId` | string | 所属分组 |
| `name` | string | 显示名 |
| `endpoint` | string | `http(s)://` 开头的 S3 端点 |
| `accessKey` | string | Access Key |
| `secretKey` | string | Secret Key |
| `enabled` | boolean | 禁用的实例不出现在分发/浏览选择中 |
| `region` | string? | 缺省按 `us-east-1` 使用 |

定义：`shared/schemas/groups.ts`（valibot schema 与 TS 类型同源）。

> 类型名历史上为 `MinioInstance`，产品定位调整后为 `S3Instance`。JSON 字段名未变，**旧 `groups.json` 可直接使用**。

## 共享类型速览（`shared/schemas/`）

| 文件 | 内容 |
|------|------|
| `groups.ts` | 实例/分组/导入导出/连通性结果 |
| `browse.ts` | 对象列表、删除结果等 |
| `task.ts` | 任务状态、SSE 事件、暂存列表项、执行器负载 |

### 任务相关（要点）

```ts
type TaskType = 'dispatch' | 'copy' | 'move' | 'upload'
type TaskStatus = 'queued' | 'running' | 'done' | 'cancelled' | 'failed'

interface FileResult {
  status: 'success' | 'failed' | 'running' | 'pending' | 'skipped'
  duration?: number
  error?: string
  sourceDeleteStatus?: 'deleted' | 'delete-failed'  // move 专用
  sourceDeleteError?: string
}
```

- `dispatch` 使用 `instanceProgress: InstanceProgress[]`（实例维度）
- `copy` / `move` / `upload` 使用 `fileProgress: FlatFileProgress`（扁平文件维度）
- `move` 可带 `currentPhase: 'copying' | 'deleting'`

## 暂存文件

| 项 | 说明 |
|----|------|
| 磁盘 | `UPLOAD_DIR/<fileId>/<safeName>`，`fileId` 形如 `uf-<uuid>` |
| 元数据 | 内存 Map；`listStagedFiles` 可读磁盘 `meta.json`（重启后仍可列出） |
| 清理 | 任务结束删除；超时由定时孤儿清理兜底 |

## 运行时数据目录

```text
server/data/
  groups.json     实例配置（备份！）
  uploads/        暂存（可丢）
```
