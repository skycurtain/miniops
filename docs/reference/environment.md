# 环境变量（权威）

本文件是环境变量的**唯一来源**。代码读取方式：`Number(process.env.X) || 默认值`（字符串则 `process.env.X || 默认值`）。

## 全局

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `UPLOAD_DIR` | `server/data/uploads` | 暂存文件根目录 |
| `MAX_UPLOAD_SIZE` | `0`（不限） | 单文件最大字节数，超限返回 413 |
| `UPLOAD_TTL_HOURS` | `24` | 暂存文件保留小时数；超时由孤儿清理删除 |
| `TASK_RETENTION_SECONDS` | `1800` | 完成任务在内存表中保留秒数（供 SSE 重连与任务查看器） |
| `TASK_DELAY_MS` | `0` | 测试用：每文件操作前延时毫秒数，便于观察排队/后台继续 |

## 并发与上限

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DISPATCH_CONCURRENCY` | `5` | 分发时实例维度并发数（实例内文件串行） |
| `COPY_MOVE_MAX_OBJECTS` | `10000` | 复制/移动递归展开前缀时的对象数上限；`0` 表示不限 |
| `DOWNLOAD_MAX_OBJECTS` | `1000` | ZIP 批量下载对象数上限 |

## 数据路径（当前为常量）

| 路径 | 说明 |
|------|------|
| `server/data/groups.json` | 实例配置（`server/utils/store.ts` 内常量，暂未提供环境变量覆盖） |
| `server/data/uploads/` | 默认暂存目录（可用 `UPLOAD_DIR` 覆盖） |

## 未使用 / 历史变量

以下名称曾出现在历史设计稿中，**当前代码不读取**：

- `MULTIPART_THRESHOLD` / `MULTIPART_PART_SIZE`（已决策不做 S3 Multipart）
- `CLEANUP_CONCURRENCY`（多实例批量清理功能未在现版实现）
- `DATA_FILE_PATH`（配置路径写死，未做成环境变量）

## 读取位置对照

| 变量 | 代码位置 |
|------|----------|
| `UPLOAD_DIR` / `MAX_UPLOAD_SIZE` | `server/utils/staging.ts` |
| `UPLOAD_TTL_HOURS` | `server/utils/staging.ts`（`cleanupOrphanedFiles`） |
| `TASK_RETENTION_SECONDS` | `server/utils/task-manager.ts` |
| `TASK_DELAY_MS` | `executors/dispatch.ts` / `upload.ts` / `copy.ts` |
| `DISPATCH_CONCURRENCY` | `executors/dispatch.ts` |
| `COPY_MOVE_MAX_OBJECTS` | `server/utils/s3.ts`（`collectObjectsByPrefixes`） |
| `DOWNLOAD_MAX_OBJECTS` | `server/api/browse/objects/download-batch.post.ts` |

## 内置常量（非环境变量）

| 常量 | 默认 | 位置 | 说明 |
|------|------|------|------|
| 任务保留清理 | 6 小时 | `server/plugins/cleanup-uploads.ts` | 暂存孤儿清理周期 |
| ListObjectsV2 单页 | 200 | `server/utils/s3.ts` | S3 上限 1000，实现取 200 |
| DeleteObjects 批大小 | 1000 | `server/utils/s3.ts` | S3 API 单次上限 |
| 文本预览大小 | 2MB | `browse-preview-modal.vue` | 超过提示下载后查看 |
| 一次删除/下载 UI 上限 | 1000 | 前端 | 与后端批限制对齐 |
