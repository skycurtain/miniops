# AGENTS.md

> 本文件供 AI 编码助手（如 Reasonix、Claude Code 等）阅读，帮助快速理解项目上下文和开发约定。

## 项目简介

miniops 是一个面向 MinIO 的批量运维操作平台。核心功能是将文件/文件夹批量分发到一组 MinIO 实例。采用 Nuxt 4 全栈模式，前端 SSR + 后端 Nitro 一体部署，MinIO 操作全部手写 SigV4 签名，零 SDK 依赖。

## 构建与运行

```bash
bun install          # 安装依赖
bun run dev          # 开发模式（http://localhost:3000）
bun run build        # 生产构建（产物在 .output/）
bun run .output/server/index.mjs  # 生产启动
```

> **注意**：`bun run dev` 触发的是 `nuxt dev`，运行时为 Node 而非 Bun。代码中不要使用 `Bun.file()` 等 Bun 专有 API，必须用 `node:fs` 等 Node 标准库保证兼容。

没有测试框架。验证方式：启动 dev server + 本地 MinIO 容器，手动端到端测试。

## 架构概要

```
浏览器 ──HTTP/SSE──► 控制中心 (Nuxt/Nitro) ──S3 协议──► N 个 MinIO 实例
```

- **代理模式**：浏览器不直连 MinIO，所有 S3 操作由后端代理。密钥不进浏览器。
- **文件分发三段式**：浏览器逐文件上传暂存磁盘 → POST /dispatch 传 fileId 列表 → 后端从磁盘读文件逐实例分发。
- **数据存储**：实例组配置存 `server/data/groups.json`（JSON 文件 + 互斥锁串行写）。暂存文件元数据存内存 Map（进程重启丢失，磁盘残留由 cleanup plugin 定时清理）。

## 关键约定

### MinIO 操作（`server/utils/minio.ts`）

- **纯手写 SigV4**：不引入 S3Client / AWS SDK。签名用 `node:crypto` + 原生 `fetch`。
- `signRequest()` 是通用签名函数（Authorization 头方式），支持任意 method/query/payloadHash。
- `presignPutUrl()` 是预签名 URL 方式，用于小文件 PUT。
- `uploadObject()` 是统一上传入口：小文件（<8MB）走 `uploadSmall`（单次预签名 PUT），大文件走 `uploadLarge`（手写 S3 Multipart Upload 三步：Initiate → UploadPart ×N → Complete）。
- 大文件上传失败时调 `abortMultipartUpload` 清理 MinIO 侧残留。
- 上传时必须精确指定 `Content-Type`，不能用 SDK 默认值（会追加 `;charset=utf-8` 导致 MinIO Console 预览失败）。

### 分发流程（`server/utils/dispatcher.ts`）

- 实例维度并发（默认 5，`DISPATCH_CONCURRENCY` 可配），实例内文件串行。
- 每个文件上传完通过 SSE 推送进度（`notify()` → `subscribeTask()` 回调）。
- 任务完成后保留 60s 再从内存表删除，供迟到的 SSE 连接查询。
- `processInstance` 从磁盘文件上传：`resolve(UPLOAD_DIR, f.storedPath)` → `uploadObject()`。
- prefix 拼接在 dispatcher 里做：`prefix/objectKey`，前端只传 `objectKey`。

### 暂存管理（`server/utils/uploads.ts`）

- `storeUpload(rawName, data, objectKeyOverride?)`：落盘到 `UPLOAD_DIR/<id>/<safeName>`，元数据存内存 Map。
- `objectKey` 优先用前端传入的（文件夹上传时为相对路径），否则从文件名推断。
- `sanitizeObjectKey()` 防路径遍历：反斜杠归一化、去段首点、过滤 `..`。
- `sanitizeFileName()` 只取最后一段文件名，用于磁盘落盘路径。
- `cleanupExpired()`：扫描 UPLOAD_DIR 子目录，超 `UPLOAD_TTL_HOURS` 的删除。内存 Map 没有的用目录 mtime 作为 fallback。

### 前端（`app/composables/useDispatch.ts` + `app/pages/ops/dispatch/index.vue`）

- Nuxt UI 组件统一用 `Nuxt` 前缀（`NuxtButton`、`NuxtInput`、`NuxtSelectMenu` 等）。
- 分发时**只传 `instanceIds`**，不传 `groupIds`（避免后端展开组内全部实例）。
- 文件夹上传时 `objectKey` 通过 FormData 字段传给后端（`form.append('objectKey', objectKey)`），保留目录结构。
- 文件列表按"单文件"和"文件夹聚合"分组展示，文件夹聚合为一条可展开。
- 进度展示为实例级聚合折叠视图（非矩阵），每行显示完成数/总数 + 进度条 + 失败计数。
- `cellKey` = `${instanceId}::${objectKey}`，用于进度矩阵单元格定位。

### 类型定义（`server/types/index.ts`）

- `MinioInstance`：没有 `bucket` 字段（已废弃，分发时通过 `instanceBuckets` 按实例指定）。
- `StoredFile`：暂存文件元数据（id/name/objectKey/size/contentType/storedPath/uploadedAt）。
- `DispatchRequest.files`：`{ id: string; objectKey?: string }[]`（引用暂存文件 id，不是文件内容）。
- `DispatchTask`：含 `resolvedInstances` 和 `resolvedFiles`（展开后的实例和文件列表）。

## API 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/groups` | 实例组列表/新增 |
| PUT/DELETE | `/api/groups/:id` | 更新/删除实例组 |
| POST | `/api/groups/:id/test` | 批量连通性测试 |
| POST/GET | `/api/groups/import` `/api/groups/export` | 导入/导出 |
| GET | `/api/groups/template` | 配置模板 |
| POST/PUT/DELETE | `/api/groups/:id/instances/...` | 组内实例管理 |
| POST | `/api/instances/buckets` | 批量获取 bucket 列表 |
| POST | `/api/uploads` | multipart 上传暂存文件 |
| DELETE | `/api/uploads/:id` | 删除暂存文件 |
| POST | `/api/dispatch` | 提交分发任务 |
| GET | `/api/dispatch/events` | SSE 进度推送 |

## 环境变量

关键：`DISPATCH_CONCURRENCY`、`MULTIPART_THRESHOLD`、`MULTIPART_PART_SIZE`、`UPLOAD_TTL_HOURS`。完整列表见 README.md 环境变量表。

## 注意事项

- `server/data/uploads/` 已在 `.gitignore` 中，不要提交暂存文件。
- `server/data/groups.json` 含 MinIO 密钥，不要提交到公开仓库。
- `nuxt.config.ts` 中 `ui.prefix: 'Nuxt'`，所有 UI 组件必须用 `Nuxt` 前缀。
- SSE 用 Nitro 的 `createEventStream`，Nginx 反代需关闭 `proxy_buffering`。
- 大文件上传需配置 Nginx `client_max_body_size 0`。
