# miniops

**S3 对象存储运维平台** —— 在一个界面里管理多套 S3 兼容对象存储：浏览对象、批量分发、复制、移动、删除。

密钥不进浏览器，所有 S3 操作由服务端代理。协议层为标准 S3（`@aws-sdk/client-s3`），可对接 MinIO、PGSTY SILO、RustFS 等兼容后端。

## 特性

- **多实例管理**：分组、启停、连通性测试（MinIO health / ListBuckets 自动降级）
- **对象浏览**：虚拟目录、上传、下载、预览（图/视频/音频/PDF/文本）、删除、复制、移动
- **批量分发**：本地文件/文件夹 → 多实例、多 bucket
- **统一任务**：FIFO 队列 + SSE 进度 + 后台继续 + 任务查看器
- **暂存管理**：上传前落盘暂存，可查看/清理
- **通用 S3**：实例可配 region，不绑定单一厂商

## 快速开始

```bash
bun install
bun run dev
# 打开 http://localhost:3000
```

需要一个 S3 兼容端点（MinIO / SILO / RustFS / …）。完整步骤见 **[docs/start/快速开始.md](docs/start/快速开始.md)**。

## 文档

权威文档在 **[docs/](docs/README.md)**（文档中心）：

| 我想… | 去这里 |
|-------|--------|
| 跑起来并完成第一次操作 | [docs/start/快速开始.md](docs/start/快速开始.md) |
| 查环境变量 / HTTP API / 数据模型 | [docs/reference/](docs/reference/) |
| 了解架构与技术方案、S3 兼容面 | [docs/design/](docs/design/) · [docs/reference/S3兼容性.md](docs/reference/S3兼容性.md) |
| 参与开发 | [docs/start/本地开发.md](docs/start/本地开发.md) · [AGENTS.md](AGENTS.md) |

## 开发

```bash
bun run dev        # 开发
bun run build      # 构建
bun run lint       # ESLint
npx nuxt typecheck # 类型检查
```

运行时**必须使用 Bun**（存在依赖 Bun 行为的修复）。

## 技术栈

- [Nuxt 4](https://nuxt.com)（SSR + Nitro，Bun preset）
- [Nuxt UI v4](https://ui.nuxt.com) + Tailwind CSS 4
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/welcome.html)（S3）
- [Valibot](https://valibot.dev)（共享 schema）

## 许可

[MIT](LICENSE) © 2026 skycurtain
