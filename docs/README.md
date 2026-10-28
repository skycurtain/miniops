# miniops 文档中心

本目录是 miniops 的**项目级权威依据与指导意见**。行为以代码为准；文档必须与代码一致，冲突时以 `reference/` 为契约层，以代码实现为最终事实。

产品定位：**S3 对象存储运维平台** —— 统一管理多套 S3 兼容对象存储的浏览、分发、复制、移动与删除。

## 目录职责

```text
docs/
  start/        入门：本地运行、Docker 后端、五分钟上手
  reference/    权威参考：环境变量、HTTP API、数据模型、S3 兼容面（唯一来源）
  design/
    交互设计/   界面契约：布局、状态、流程、边界
    技术方案/   系统如何工作：架构、执行器、协议层、暂存、配置存储
```

## 按角色阅读

| 你是 | 从这里开始 |
|------|------------|
| 使用者 / 运维 | [start/快速开始.md](start/快速开始.md) |
| 开发者 / 贡献者 | [start/本地开发.md](start/本地开发.md) → [reference/](reference/) → [design/](design/) |
| 对接 API 的程序 | [reference/HTTP接口.md](reference/HTTP接口.md) |
| 要接新 S3 后端 | [reference/S3兼容性.md](reference/S3兼容性.md) |
| 查环境变量 | [reference/环境变量.md](reference/环境变量.md) |

## 内容地图

### start/

- [快速开始.md](start/快速开始.md) — 跑起来并完成一次分发
- [本地开发.md](start/本地开发.md) — 开发环境、命令、调试

### reference/

- [环境变量.md](reference/环境变量.md) — 全部环境变量（权威）
- [HTTP接口.md](reference/HTTP接口.md) — HTTP API 契约（权威）
- [数据模型.md](reference/数据模型.md) — 持久化数据与共享类型（权威）
- [S3兼容性.md](reference/S3兼容性.md) — 依赖的 S3 API 面与实测矩阵

### design/交互设计/

- [全局与导航.md](design/交互设计/全局与导航.md) — 布局骨架、顶栏、路由
- [实例管理.md](design/交互设计/实例管理.md) — 分组与实例表、表单、连通性、导入导出
- [对象浏览.md](design/交互设计/对象浏览.md) — 标签页、列表、预览、上传/删除/复制移动
- [文件分发.md](design/交互设计/文件分发.md) — 阶段机、目标选择、进度与重试
- [任务与暂存.md](design/交互设计/任务与暂存.md) — 任务查看器角标、暂存面板

### design/技术方案/

- [统一任务架构.md](design/技术方案/统一任务架构.md) — 任务框架与生命周期
- [任务执行器.md](design/技术方案/任务执行器.md) — 分发 / 上传 / 复制 / 移动
- [S3协议层.md](design/技术方案/S3协议层.md) — 客户端、探测、对象操作
- [暂存.md](design/技术方案/暂存.md) — 磁盘暂存与清理
- [配置存储.md](design/技术方案/配置存储.md) — groups.json 与写锁

## 编写规范（Documentation Policy）

1. **唯一来源**：环境变量、HTTP 路由、数据字段、S3 API 依赖只写在 `reference/`。其他文档引用链接，不复制粘贴完整表。
2. **只写现状**：描述当前架构与行为；不写决策过程、变更历史、曾经有过的方案。
3. **与代码同 PR 更新**：改行为必须同步改 `reference/` 与相关 `design/`；仅改表述不强制。
4. **中文为主**；命令、API 路径、类型名保持英文原文。
5. **禁止平行副本**：同一主题只在一处展开，其他位置用链接。
