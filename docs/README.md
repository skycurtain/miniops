# miniops 文档中心

本目录是 miniops 的**项目级权威依据与指导意见**。行为以代码为准；文档必须与代码一致，冲突时以 `reference/` 为契约层，以代码实现为最终事实。

产品定位：**S3 对象存储运维平台** —— 统一管理多套 S3 兼容对象存储的浏览、分发、复制、移动与删除。

## 目录职责

```text
docs/
  start/        入门：本地运行、Docker 后端、五分钟上手
  guides/       任务手册：按操作场景写「怎么做」
  reference/    权威参考：环境变量、HTTP API、数据模型、S3 兼容面（唯一来源）
  design/       架构决策与技术方案（带 Status 生命周期）
```

## 按角色阅读

| 你是 | 从这里开始 |
|------|------------|
| 使用者 / 运维 | [start/quickstart.md](start/quickstart.md) → [guides/](guides/) |
| 开发者 / 贡献者 | [start/local-dev.md](start/local-dev.md) → [reference/](reference/) → [design/](design/) |
| 对接 API 的程序 | [reference/http-api.md](reference/http-api.md) |
| 要接新 S3 后端 | [reference/s3-compatibility.md](reference/s3-compatibility.md) |
| 查环境变量 | [reference/environment.md](reference/environment.md) |

## 内容地图

### start/

- [quickstart.md](start/quickstart.md) — 跑起来并完成一次分发
- [local-dev.md](start/local-dev.md) — 开发环境、命令、调试

### guides/

- [manage-instances.md](guides/manage-instances.md) — 实例与分组管理
- [browse-objects.md](guides/browse-objects.md) — 对象浏览、上传、预览、删除、复制/移动
- [dispatch-files.md](guides/dispatch-files.md) — 本地文件批量分发
- [task-viewer.md](guides/task-viewer.md) — 任务查看器与暂存管理

### reference/

- [environment.md](reference/environment.md) — 全部环境变量（权威）
- [http-api.md](reference/http-api.md) — HTTP API 契约（权威）
- [data-model.md](reference/data-model.md) — 持久化数据与共享类型（权威）
- [s3-compatibility.md](reference/s3-compatibility.md) — 依赖的 S3 API 面与实测矩阵

### design/

- [unified-task-architecture.md](design/unified-task-architecture.md) — 统一任务架构（Status: Shipped）
- [product-positioning.md](design/product-positioning.md) — 产品定位从 MinIO 到通用 S3（Status: Shipped）

## 编写规范（Documentation Policy）

1. **唯一来源**：环境变量、HTTP 路由、数据字段、S3 API 依赖只写在 `reference/`。其他文档引用链接，不复制粘贴完整表。
2. **design 带 Status**：文档顶部声明 `Status: Draft | In progress | Implemented | Shipped`。落地后只改 Status，不搬家。
3. **历史过程稿不进正文**：superseded 材料如需暂存，放 `archive/` 并随时可删；文档中心不得依赖其存在。
4. **与代码同 PR 更新**：改行为必须同步改 `reference/`；仅改表述不强制。
5. **中文为主**；命令、API 路径、类型名保持英文原文。
6. **禁止平行副本**：同一主题只在一处展开，其他位置用链接。
