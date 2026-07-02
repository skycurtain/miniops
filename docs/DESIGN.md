# miniops 功能与设计文档

> miniops 是一个面向 MinIO 的批量运维操作平台。实施人员在控制中心通过 Web 界面，将更新后的 JSON 配置文件批量分发到一组 MinIO 实例。当前应用场景为地铁项目（每个车站各自运行一个 MinIO 实例），但工具本身不预设业务语义，通用适用于任何多 MinIO 实例的批量运维场景。

---

## 一、业务背景

- 工具的核心能力是"对一组 MinIO 实例做批量操作"。
- 当前应用场景：地铁项目部署在每一个车站的服务器上，每个车站各自运行一个 MinIO 实例，存放项目依赖的 JSON 配置文件。
- 配置文件更新后，需要由实施人员在控制中心统一批量推送到所有目标 MinIO 实例。
- 未来可能扩展更多批量运维功能（校验、删除、巡检等），因此项目命名为 **miniops**（MinIO + ops）。
- 工具本身与"车站"解耦：业务语义由用户通过实例名称和实例组自行表达，工具只认实例组和 MinIO 实例。

---

## 二、技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端框架 | Nuxt 4 + Vue 3 | 全栈模式，`server/api/` 编写后端接口 |
| UI 组件库 | Nuxt UI v4 | 125+ 组件全免费（MIT），含 Table / FileUpload / Progress |
| 运行时 | Bun | 包管理 + 开发/生产运行时 |
| 样式 | Tailwind CSS v4 | 随 Nuxt UI v4 内置 |
| MinIO 操作 | Bun 内置 `S3Client` | S3 兼容协议，已验证可用 |

### 关键技术决策

- **以组为核心**：实例不独立存在，始终嵌套在某个实例组中。交互逻辑单一明确：创建组 → 组内添加实例 → 分发时选组。
- **代理模式**：浏览器 → 控制中心后端 → 各 MinIO 实例。密钥不进浏览器，浏览器无需直连内网实例。
- **部署形态**：Nuxt 全栈（非单 exe）。控制中心常驻服务器，用 Bun 运行 Nitro 产物。
- **组件前缀**：`prefix: 'Nuxt'`，所有 Nuxt UI 组件使用 `Nuxt` 前缀（如 `NuxtButton`、`NuxtTable`）。
- **Content-Type 修复**：上传 JSON 时用预签名 PUT URL 手动指定 `Content-Type: application/json`，绕开 Bun `S3Client.write()` 自动追加 `;charset=utf-8` 导致 MinIO Console 无法预览的问题。

---

## 三、核心实体

### 实例组（InstanceGroup）

实例组是管理的核心单位。实例不独立存在，始终属于某一个实例组。

```ts
interface InstanceGroup {
  id: string
  name: string           // 如"1号线"、"核心机房"
  description?: string
  instances: MinioInstance[]   // 直接嵌套，实例不独立存在
}
```

### MinIO 实例（MinioInstance）

实例嵌套在组内，组内唯一即可。

```ts
interface MinioInstance {
  id: string              // 组内唯一即可
  name: string            // 业务语义由用户自由填写，如"人民广场站"
  endpoint: string        // http://10.24.0.10:9000
  accessKey: string
  secretKey: string
  bucket?: string         // 该实例最常用的默认 bucket，如 ndm；分发时可覆盖
  enabled: boolean        // 是否启用
}
```

> **关于一个实例属于多个组**：不支持。实例只属于一个组。若需跨组复用，通过"导出再导入"或"组内复制实例"实现。

### 分发任务（DispatchTask）

一次"批量上传"操作。目标支持选组（全选组内实例）和选单个实例，可跨组多选。

```ts
interface DispatchResult {
  groupId: string
  instanceId: string
  fileName: string
  status: 'success' | 'failed'
  error?: string
}

interface DispatchTask {
  id: string
  files: { name: string; content: string }[]
  groupIds: string[]      // 选中的实例组（展开为组内所有启用的实例）
  instanceIds: string[]   // 单独勾选的实例（与 groupIds 合并去重）
  bucket?: string         // 分发目标 bucket，覆盖实例默认值；两者皆空则报错
  status: 'pending' | 'running' | 'done'
  results: DispatchResult[]
}
```

---

## 四、功能规划

### MVP（首批实现）

| 模块 | 功能 | 说明 |
|---|---|---|
| 实例组管理 | 增删改查组 | 创建/编辑/删除实例组 |
| 实例组管理 | 组内实例管理 | 在组内新增/编辑/删除/复制实例 |
| 实例组管理 | 连通性测试 | 对单个/组内全部实例做 ping |
| 实例组管理 | 导入/导出 | 通过 JSON 文件批量导入组配置；导出当前配置 |
| 文件分发 | 选择文件 | 本地选 JSON 文件（可多选），上传到控制中心后端 |
| 文件分发 | 选择目标 | 多选实例组（可跨组多选） |
| 文件分发 | 批量上传 | 后端代理，展开组为实例，遍历上传 |
| 文件分发 | 实时进度 | 实例 × 文件 的进度矩阵，SSE 推送 |
| 结果汇总 | 成功/失败统计 | 失败可单独重试 |

### 导入/导出设计

- **格式**：直接使用实例组的 JSON 数组（含嵌套实例），无需另发明格式。

```json
[
  {
    "id": "grp-001",
    "name": "1号线",
    "description": "1号线全部车站",
    "instances": [
      {
        "id": "inst-001",
        "name": "人民广场站",
        "endpoint": "http://10.24.0.10:9000",
        "accessKey": "minioadmin",
        "secretKey": "minioadmin",
        "bucket": "ndm",
        "enabled": true
      }
    ]
  }
]
```

- **冲突策略**：导入时遇到已存在的组 `id`，MVP 阶段先做最简单的"覆盖模式"（按 id 匹配，有则更新、无则新增）。后续可扩展"跳过/覆盖/报错中止"三选一。
- **入口**：实例组管理页放"导入"按钮（`NuxtFileUpload` 限定 `.json`）+ "导出"按钮（直接下载）。
- **跨组复用**：导出 A 组 → 导入时改 id/名称成为 B 组，或在组内复制实例。

### 未来扩展（预留，暂不实现）

- 文件校验：对比各实例文件版本/内容是否一致
- 批量删除 / 批量下载
- 定时分发 / 计划任务
- 用户认证（实施人员登录）

---

## 五、页面布局

整体采用 Nuxt UI v4 的 Dashboard 布局：左侧 `NuxtSidebar` 导航 + 顶部 `NuxtHeader` + 主内容区。

```
┌─────────────────────────────────────────────┐
│  Header  [miniops]          [主题] [用户]    │
├──────────┬──────────────────────────────────┤
│          │                                  │
│  总览   │                                  │
│  实例   │          主内容区                 │
│  运维 │                                  │
│   文件分发│                                  │
│          │                                  │
└──────────┴──────────────────────────────────┘
```

### 文件路由

```
app/pages/
├── index.vue              # 总览
├── groups/
│   └── index.vue          # 实例（实例组 + 实例管理）
└── ops/
    └── dispatch/
        └── index.vue      # 运维 > 文件分发
```

### 各页面职责

#### 1. 总览 `/`

- 实例组数量、实例总数、在线/离线数
- 快速入口（去分发、去管理实例）
- 最近一次分发结果概览

#### 2. 实例 `/groups`

- `NuxtTable` 展示实例组列表（名称、描述、实例数）
- 新增/编辑实例组（`NuxtModal` + `NuxtForm`）
- 点击组展开/进入详情，管理组内实例：
  - 新增实例、编辑实例、删除实例、复制实例
  - 行内：测试连通性、启用/禁用
  - 批量测试
- 导入按钮（`NuxtFileUpload` 限定 `.json`）+ 导出按钮（下载）

#### 3. 文件分发 `/ops/dispatch`（核心页，位于"运维"一级菜单下）

- 顶部：`NuxtFileUpload` 选文件区（支持多文件、拖拽）
- 中部：分组 Table（`NuxtTable` 可展开行）
  - 组行：组名、实例数、在线数，带 checkbox（勾选=全选组内实例）
  - 实例行：名称、endpoint、bucket、状态，带 checkbox（精确勾选）
  - 父子 checkbox 联动
- bucket 选择器（表头/表格上方）：`NuxtSelect` 下拉框
  - 候选项随选中实例动态更新：收集选中实例的 bucket 去重
  - 只有一个值 → 自动预填；多个值 → 列出供选择；为空 → 手动输入
  - 任务级参数，一次性覆盖所有选中实例
- 底部：`NuxtButton` 开始分发
- 执行后：进度矩阵 `NuxtTable`（行=实例，列=文件，单元格=成功/失败/进行中），SSE 实时更新
- 失败行支持"重试"

---

## 六、后端接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/groups` | 获取实例组列表（含嵌套实例） |
| POST | `/api/groups` | 新增实例组 |
| PUT | `/api/groups/:id` | 更新实例组（含组内实例的增删改） |
| DELETE | `/api/groups/:id` | 删除实例组 |
| POST | `/api/groups/:id/test` | 批量测试组内实例连通性 |
| POST | `/api/groups/import` | 导入实例组（JSON） |
| GET | `/api/groups/export` | 导出实例组（JSON） |
| POST | `/api/dispatch` | 提交分发任务（文件 + groupIds + instanceIds + bucket） |
| GET | `/api/dispatch/events` | SSE 流，实时推送分发进度 |

### 分发执行流程

```
前端 POST /api/dispatch（files + groupIds + instanceIds + bucket）
  → 后端展开 groupIds 为实例列表，与 instanceIds 合并去重（仅 enabled 实例）
  → 创建任务，返回 taskId
  → 后台并发执行（实例维度并发，默认 5）
    → 每个实例：遍历文件，用预签名 PUT 上传到该实例 MinIO
    → 每个文件上传完，通过 SSE 推送 {groupId, instanceId, fileName, status}
  → 全部完成后推送任务完成事件
```

### 并发策略

- 实例维度并发：同时处理 N 个实例（默认 5，可配置）
- 每个实例内文件串行上传
- 控制中心带宽友好，不会打满单台实例

---

## 七、数据存储

### MVP 阶段：配置文件

- 实例组清单存储在 `server/data/groups.json`（含嵌套实例）
- 简单直接，适合少量组（几条到几十条）
- 通过 `server/utils/store.ts` 统一读写

### 未来演进：SQLite

- 当需要存储历史任务等结构化数据时，迁移到 `bun:sqlite`
- 实例组迁移到 SQLite 表

---

## 八、目录结构（规划）

```
miniops/
├── app/
│   ├── app.vue                    # 根组件（NuxtApp 包裹）
│   ├── assets/css/main.css        # Tailwind + Nuxt UI 样式
│   ├── components/
│   │   └── AppLayout.vue          # Dashboard 布局（Sidebar + Header）
│   ├── composables/
│   │   └── useDispatch.ts           # 分发相关前端逻辑
│   └── pages/
│       ├── index.vue              # 仪表盘
│       ├── groups/index.vue       # 实例组管理
│       └── dispatch/index.vue       # 文件分发
├── server/
│   ├── api/
│   │   ├── groups/
│   │   │   ├── index.get.ts       # GET /api/groups
│   │   │   ├── index.post.ts      # POST /api/groups
│   │   │   ├── [id].put.ts        # PUT /api/groups/:id
│   │   │   ├── [id].delete.ts     # DELETE /api/groups/:id
│   │   │   ├── [id]/test.post.ts  # POST /api/groups/:id/test
│   │   │   ├── import.post.ts     # POST /api/groups/import
│   │   │   └── export.get.ts      # GET /api/groups/export
│   │   └── dispatch/
│   │       ├── index.post.ts      # POST /api/dispatch
│   │       └── events.get.ts      # GET /api/dispatch/events (SSE)
│   ├── data/
│   │   └── groups.json            # 实例组清单数据（含嵌套实例）
│   ├── types/
│   │   └── index.ts               # 后端类型定义
│   └── utils/
│       ├── minio.ts               # MinIO 操作封装
│       └── store.ts               # 数据读写
├── nuxt.config.ts
├── package.json
└── tsconfig.json
```

---

## 九、当前状态

- [x] 项目初始化（Nuxt 4 + Nuxt UI v4 + Bun）
- [x] Git 首次提交
- [x] Dashboard 布局
- [ ] 实例组管理（组 CRUD + 组内实例管理 + 连通性测试 + 导入导出）
- [ ] 文件分发（核心功能）
- [ ] 仪表盘
