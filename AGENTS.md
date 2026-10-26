# AGENTS.md — 编码代理须知

本文是与编码 Agent（Claude Code、MiMo 等）的协作契约。行为以代码为准；**架构、接口、环境变量的权威描述在 [docs/](docs/README.md)**，本文只写规则、约定、坑与路径速查。

## 项目是什么

**miniops**：S3 对象存储运维平台。多实例管理、对象浏览、批量分发、复制/移动/删除。Nuxt 4 全栈（前端 + Nitro API），无数据库，配置落在 JSON 文件。

## 必须遵守

1. **运行时用 Bun**。`bun run dev` / `bun run build` / `bun run start`。不要假设 Node 行为一致。
2. **文档中心是权威**。改行为 → 同步更新 `docs/reference/`（API / 环境变量 / 数据模型）。不要在 README/AGENTS 复制 reference 全文。
3. **Nuxt UI 组件前缀是 `Nuxt*`**（`NuxtButton`、`NuxtModal`、`NuxtTooltip`…），不是 `U*`。
4. **命名**：S3 实例类型是 `S3Instance` / `s3InstanceSchema`；协议层是 `server/utils/s3.ts`（已从 `minio.ts` 更名）。
5. **提交纪律**：
   - **绝不擅自 `git commit` / `git push`**；用户点名后才提交；push 永远由用户执行。
   - 提交信息：`type(scope): 中文描述`（如 `feat(staging): …`、`fix(tasks): …`、`docs: …`）。
   - 按功能拆 commit，不要把无关文件搅在一起。
6. **不要提交**：
   - `server/data/`（运行时数据，含密钥）
   - `*.log`、构建产物、`.playwright-cli/` 等会话残留
   - 用户本地 backlog（如 `后续功能.md`）
   - 测试过程清单 / 交接文档

## 禁止

- 不要在未改代码时声称「行为已对齐文档」。
- 不要引入 S3 Multipart Upload / 预签名 URL / 自写 SigV4——当前**已决策不做**（见 `docs/design/unified-task-architecture.md`）。除非任务明确要求。
- 不要把 `docs/reference/` 里的契约改成「大概」——字段名、路由、默认值要与代码一致。
- 不要删除或改写用户未要求动的 `后续功能.md`。
- 不要假设存在 `bun` 时的全局安装脚本入口；Windows 上 compose 命令是 `docker-compose`（独立 exe）。

## 路径速查

| 路径 | 职责 |
|------|------|
| `server/utils/s3.ts` | S3 客户端、连通性探测、对象操作 |
| `server/utils/task-manager.ts` | 任务 FIFO + 订阅 + 保留清理 |
| `server/utils/staging.ts` | 磁盘暂存、TTL 孤儿清理 |
| `server/utils/store.ts` | 实例/分组（`server/data/groups.json`） |
| `server/utils/executors/` | `dispatch` / `upload` / `copy` / `move` |
| `server/utils/sse.ts` | SSE 封装 |
| `shared/schemas/` | 前后端共享类型（valibot） |
| `app/composables/use-task-manager.ts` | 前端任务状态 |
| `docs/reference/` | API / 环境变量 / 数据模型 / S3 兼容（权威） |

## 架构要点（详见 docs/design/）

- 长操作统一走 **taskId**：`createTask` → executor → SSE `progress/complete/cancelled`。
- 任务与 SSE 连接解绑：关页面不中断，重连 `GET /api/tasks/:id/state` 可恢复。
- 全局 FIFO，同一时刻一个执行中任务；**暂存不进队列**。
- 上传策略：`readFile` Buffer + **单次 PUT**，无 Multipart。
- move = copy + 删源，**非原子**。
- 取消：每文件开始前检查；未开始标 `skipped`；单文件失败 ≠ 任务 failed（`done` + `summary.failed>0` 为部分失败）。

## 已知坑（勿踩回去）

1. **Bun `readFormData`** 会给 multipart 的 Content-Type 追加 `;charset=utf-8` → 存进对象存储会导致 Console 预览失败。一律用 `inferContentType(objectKey)`，**不要信任 `file.type`**。
2. **Bun 解析非 ASCII multipart filename** 时 `File.name` 可能为 `undefined`。前端需显式传 `originalName`。
3. **`AggregateError.message` 可能为空**（如 ECONNREFUSED）→ 用 `formatExecError` / `formatS3Error` 从 `errors[]` 取文案。
4. 执行中任务的 `summary` 为 `null`（结束才算）→ 进度从 `fileProgress.results` **实时统计**。
5. **取消时不要立刻关 SSE**（`cleanupConnection`），否则终态 / `skipped` 进度到不了前端。
6. 跨实例复制将流缓冲为 Buffer 再 PUT：部分 S3 实现不接受 chunked（无 Content-Length）。
7. `DeleteObjects` 需要 **Content-MD5**（middleware 注入）；每批最多 1000 keys。
8. 暂存成功未提交靠 TTL 兜底；`retryFailed` 只重跑失败项，不删已成功暂存。

## UI / TS 细节

- `@click="open = true"` 会 TS2322（表达式返回 boolean）→ 用 `@click="() => { open = true }"`。
- 实例类型已更名 `S3Instance`；若搜索 `MinioInstance` 会搜不到。
- 导航文案为「S3 对象存储运维平台」，不要再写「MinIO 批量运维」。

## 测试与验收

| 项 | 命令 / 动作 |
|----|-------------|
| 类型 | `npx nuxt typecheck`（或 `bun run typecheck`） |
| Lint | `bun run lint` |
| 黄金路径 | 实例管理 → 浏览 → 上传或分发 一条 |
| 本地后端 | Docker：MinIO 9000、RustFS 9010、SILO 9020（凭据常用 minioadmin） |
| 慢任务模拟 | `TASK_DELAY_MS`（毫秒） |

行为改动后：**typecheck 通过 + 更新 `docs/reference/`** 再宣称完成。

## 文档规范摘要

- 唯一来源：env / API / 字段 / S3 依赖只写在 `docs/reference/`。
- `docs/design/` 文档带 `Status:`（Draft → … → Shipped）。
- 中文正文；命令、路径、类型名保持英文。
