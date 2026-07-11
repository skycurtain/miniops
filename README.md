# miniops

面向 MinIO 的批量运维操作平台。运维人员通过 Web 界面，将文件/文件夹批量分发到一组 MinIO 实例。

## 功能概览

- **实例组管理**：创建/编辑/删除实例组，组内管理 MinIO 实例（增删改查、复制、启用/禁用）
- **连通性测试**：对单个或组内全部 MinIO 实例做健康检查
- **导入/导出**：通过 JSON 文件批量导入实例组配置，或导出当前配置
- **文件分发**（核心功能）：
  - 支持任意类型文件、整个文件夹、大文件（GB 级）
  - 文件先暂存服务端磁盘，再逐实例分发
  - 小文件单次 PUT，大文件手写 S3 Multipart Upload
  - 实时 SSE 进度推送，实例级聚合折叠视图
  - 可选目标前缀（分发到 `bucket/prefix/` 下）
  - 失败实例支持单独重试

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Nuxt 4 + Vue 3（全栈模式） |
| UI | Nuxt UI v4 + Tailwind CSS v4（组件统一 `Nuxt` 前缀） |
| 运行时 | Bun（推荐）/ Node.js 18+ |
| 校验 | valibot |
| MinIO 操作 | 手写 AWS SigV4（`node:crypto` + 原生 `fetch`，零 SDK 依赖） |

## 快速开始

```bash
# 安装依赖
bun install

# 开发模式（默认 http://localhost:3000）
bun run dev

# 生产构建
bun run build

# 生产启动
bun run .output/server/index.mjs
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口 |
| `DISPATCH_CONCURRENCY` | `5` | 文件分发并发数 |
| `DATA_FILE_PATH` | `server/data/groups.json` | 实例组数据文件路径 |
| `UPLOAD_DIR` | `server/data/uploads` | 文件分发暂存目录 |
| `MAX_UPLOAD_SIZE` | `0` | 单文件最大字节数，0 表示不限 |
| `MULTIPART_THRESHOLD` | `8388608`（8MB） | 超过此大小走 multipart 上传 |
| `MULTIPART_PART_SIZE` | `5242880`（5MB） | 分片大小（S3 最小 5MB） |
| `UPLOAD_TTL_HOURS` | `24` | 孤儿暂存文件清理时长（小时） |

## 项目结构

```
miniops/
├── app/                          # 前端
│   ├── components/AppLayout.vue  # Dashboard 布局
│   ├── composables/useDispatch.ts # 分发状态管理
│   └── pages/
│       ├── index.vue             # 总览
│       ├── groups/index.vue      # 实例管理
│       └── ops/dispatch/index.vue # 文件分发（核心页）
├── server/                       # 后端（Nitro）
│   ├── api/
│   │   ├── groups/               # 实例组 CRUD + 导入导出 + 连通性测试
│   │   ├── dispatch/             # 分发任务 + SSE 进度
│   │   ├── instances/            # bucket 列表查询
│   │   └── uploads/              # 文件暂存上传/删除
│   ├── plugins/cleanup.ts        # 孤儿暂存定时清理
│   ├── types/index.ts            # 类型定义
│   ├── utils/
│   │   ├── minio.ts              # SigV4 签名 + uploadObject + multipart
│   │   ├── dispatcher.ts         # 分发执行器（并发 + SSE）
│   │   ├── uploads.ts            # 暂存文件管理
│   │   ├── store.ts              # 实例组数据读写（JSON 文件）
│   │   └── validate.ts           # 校验工具


## 许可

本项目基于 [MIT License](./LICENSE) 开源。
