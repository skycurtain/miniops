# 本地开发

面向贡献者：环境、命令、调试与验收约定。

## 运行时

- **必须使用 Bun**。历史修复依赖 Bun 行为（`readFormData` / 非 ASCII filename 等），改用 Node 可能回归。
- Nitro 构建产物由 `nuxt.config.ts` 中 `nitro.preset: 'bun'` 决定；部署形态未定。

## 常用命令

```bash
bun install
bun run dev          # 开发服 localhost:3000
bun run build        # 构建 .output
bun run start        # 本地运行构建产物（非完整部署方案）
bun run lint         # ESLint
bun run typecheck    # nuxt typecheck
```

若本机无 `bun run typecheck` 等价入口，可用 `npx nuxt typecheck`。

## 目录结构（与文档对应）

```text
app/                  Nuxt 前端（pages / components / composables）
server/
  api/                HTTP 路由（见 reference/http-api.md）
  utils/
    s3.ts             S3 协议层（客户端、探测、对象操作）
    task-manager.ts   任务队列 + SSE
    staging.ts        磁盘暂存
    store.ts          实例配置（groups.json）
    executors/        dispatch / upload / copy / move
  data/               运行时数据（gitignore）
shared/schemas/       前后端共享类型（valibot）
docs/                 文档中心（本目录）
```

## 数据文件

| 路径 | 内容 | 备份建议 |
|------|------|----------|
| `server/data/groups.json` | 实例组与实例配置 | **应备份**（含密钥） |
| `server/data/uploads/` | 暂存文件（TTL 清理） | 可不备份 |

二者默认 gitignore。

## 调试提示

- **任务慢速模拟**：设 `TASK_DELAY_MS`（毫秒），每个文件操作前人为延时，便于观察排队与后台继续。
- **SSE**：进度走 `GET /api/tasks/:taskId/events`；反向代理需关闭 `proxy_buffering`。
- **Windows Docker**：`docker compose` 可能不可用，使用 `docker-compose`。

## 验收约定

- 类型检查：`npx nuxt typecheck` 通过
- UI 改动：走通黄金路径（实例管理 → 浏览 → 上传/分发 一条）
- 行为改动：同步更新 [reference/](../reference/)

## 文档

改行为必读 [docs/README.md](../README.md) 的编写规范。
