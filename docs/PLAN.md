# miniops 实施计划

> 基于 [DESIGN.md](./DESIGN.md) 和 [TECH.md](./TECH.md)，将开发工作拆分为 5 个阶段，每阶段产出可验证的成果。

---

## 阶段总览

| 阶段 | 名称 | 目标 | 预估工作量 |
|---|---|---|---|
| Phase 0 | 项目骨架 ✅ | Dashboard 布局 + 路由 + 导航 | 小 |
| Phase 1 | 数据层 + 实例管理 ✅ | 后端数据存储 + 实例组/实例 CRUD + 前端管理页 | 大 |
| Phase 2 | 连通性测试 + 导入导出 ✅ | 连通性测试功能 + JSON 导入导出 | 中 |
| Phase 3 | 文件分发（核心） ✅ | 分发执行 + SSE 进度 + 前端分发页 | 大 |
| Phase 4 | 总览 + 收尾 ✅ | 仪表盘统计 + 细节打磨 + 部署文档 | 中 |

---

## Phase 0：项目骨架 ✅

**目标**：搭好 Dashboard 布局和路由，所有页面可访问（空壳）。

### 任务清单

- [x] 创建 `app/components/AppLayout.vue`
  - `NuxtSidebar`：导航项（总览 / 实例 / 运维 > 文件分发）
  - `NuxtHeader`：Logo + 色盲切换 + 暗色模式切换
  - 主内容区 `<slot />`
- [x] 修改 `app/app.vue`，用 `AppLayout` 包裹 `NuxtPage`
- [x] 创建三个页面空壳：
  - `app/pages/index.vue` — 总览（占位文字）
  - `app/pages/groups/index.vue` — 实例（占位文字）
  - `app/pages/ops/dispatch/index.vue` — 文件分发（占位文字）
- [x] 配置侧边栏导航项（含"运维"可展开子菜单）

### 验收标准

- `bun run dev` 启动后，三个页面均可通过侧边栏访问
- 暗色模式切换正常
- 页面间导航正常，当前菜单项高亮

---

## Phase 1：数据层 + 实例管理 ✅

**目标**：完成后端数据存储和实例组/实例的增删改查，前端管理页可用。

### 任务清单

#### 后端

- [x] 创建 `server/types/index.ts` — 类型定义
- [x] 创建 `server/data/groups.json` — 初始数据（含默认组）
- [x] 创建 `server/utils/store.ts` — 数据读写层
  - 读写 `groups.json`，互斥锁保证并发安全
  - 默认组自动初始化
  - ID 生成（`crypto.randomUUID()`）
- [x] 实现 API：
  - `GET /api/groups` — 获取所有组（含嵌套实例）
  - `POST /api/groups` — 新增组
  - `PUT /api/groups/:id` — 更新组信息
  - `DELETE /api/groups/:id` — 删除组（默认组不可删）
  - `POST /api/groups/:id/instances` — 组内新增实例
  - `PUT /api/groups/:id/instances/:instanceId` — 更新实例
  - `DELETE /api/groups/:id/instances/:instanceId` — 删除实例
  - `POST /api/groups/:id/instances/:instanceId/duplicate` — 复制实例

#### 前端

- [x] `app/pages/groups/index.vue` — 实例管理页
  - `NuxtTable` 展示组列表（名称、描述、实例数、操作按钮）
  - `NuxtModal` + `NuxtForm` — 新增/编辑组
  - 点击组行展开 → 内嵌实例 `NuxtTable`
  - 实例行操作：编辑（Modal）、复制、删除、启用/禁用切换
  - 新增实例 Modal：名称、endpoint、accessKey、secretKey、bucket（可选）、enabled
- [x] 数据获取用 `useFetch`，操作后 `refresh()` 刷新

### 验收标准

- 可创建/编辑/删除实例组
- 可在组内新增/编辑/删除/复制实例
- 默认组存在且不可删除
- 刷新页面后数据持久（`groups.json` 正确写入）
- 表单校验：endpoint 格式、必填项

---

## Phase 2：连通性测试 + 导入导出 ✅

**目标**：实例管理页增加连通性测试和导入导出功能。

### 任务清单

#### 后端

- [x] 创建 `server/utils/minio.ts` — MinIO 操作封装
  - `testConnectivity(instance)` — 请求 `endpoint/minio/health/live`，返回 `{ online, latency, error }`
- [x] 实现 API：
  - `POST /api/groups/:id/test` — 测试组内所有实例
  - `POST /api/groups/import` — 导入 JSON（覆盖模式）
  - `GET /api/groups/export` — 导出 JSON

#### 前端

- [x] 连通性测试
  - 组详情内"测试全部"按钮 → 调用 `POST /api/groups/:id/test`
  - 实例行内"测试"按钮 → 单个测试
  - 结果展示：在线/离线状态标签（`NuxtBadge`），延迟毫秒数
- [x] 导入/导出
  - 页面顶部"导入"按钮 → `NuxtFileUpload`（accept=".json"）→ 读取文件 → `POST /api/groups/import`
  - "导出"按钮 → 下载 `GET /api/groups/export` 的 JSON
  - 导入结果提示（新增 N 条、更新 M 条）

### 验收标准

- 可测试单个实例和组内全部实例的连通性
- 在线状态正确显示（绿/红 + 延迟）
- 可导入 JSON 文件，覆盖模式正常工作
- 可导出当前配置为 JSON 文件
- 导出后再导入，数据一致

---

## Phase 3：文件分发（核心） ✅

**目标**：完成文件分发全流程——选文件、选目标、执行、实时进度。

### 任务清单

#### 后端

- [x] 创建 `server/utils/dispatcher.ts` — 分发执行器
  - 并发控制（信号量，默认 5）
  - 每个实例：遍历文件，用 `uploadJson()` 上传
  - 进度回调：每个文件完成后回调 `onProgress(result)`
- [x] 完善 `server/utils/minio.ts`
  - `uploadJson(instance, bucket, filename, content)` — 预签名 PUT + fetch
- [x] 实现 API：
  - `POST /api/dispatch` — 创建任务，返回 taskId，后台异步执行
  - `GET /api/dispatch/events?taskId=xxx` — SSE 流
- [x] SSE 实现（Nitro `createEventStream`）
  - 注册 taskId → stream 映射
  - dispatcher 进度回调 → push 到 stream
  - 任务完成 → push complete 事件
  - 连接关闭 → 清理订阅

#### 前端

- [x] 创建 `app/composables/useDispatch.ts`
  - 状态：files, selectedGroupIds, selectedInstanceIds, bucket, results, isRunning
  - `bucketOptions` computed — 选中实例 bucket 去重
  - `submit()` — POST + 建立 SSE 监听
- [x] `app/pages/ops/dispatch/index.vue` — 分发页
  - 顶部：`NuxtFileUpload`（multiple, accept=".json"）→ 读取文件内容
  - 中部：分组 `NuxtTable`（可展开行）
    - 组行 checkbox + 实例行 checkbox + 父子联动
  - bucket 选择器：`NuxtSelect`，候选项动态更新
  - "开始分发"按钮 → `submit()`
  - 进度矩阵：`NuxtTable`（行=实例, 列=文件, 单元格=状态图标）
  - SSE 实时更新单元格
  - 失败行"重试"按钮

### 验收标准

- 可选择多个 JSON 文件并读取内容
- 分组 Table 正确展示组+实例，checkbox 父子联动
- bucket 选择器候选项随选中实例动态更新
- 点击分发后，进度矩阵实时更新（SSE）
- 成功/失败状态正确显示
- 失败行可重试
- 并发数受控（不超 5 个同时上传）
- 上传后的 JSON 在 MinIO Console 中可预览（Content-Type 正确）

---

## Phase 4：总览 + 收尾 ✅

**目标**：完成仪表盘统计，打磨细节，输出部署文档。

### 任务清单

- [x] `app/pages/index.vue` — 总览页
  - 统计卡片：实例组数、实例总数、启用/禁用数（`NuxtCard` + `useFetch`）
  - 快速入口按钮（去分发、去管理实例）
  - 最近一次分发结果概览（从 sessionStorage 读取 last dispatch）
- [x] 细节打磨
  - 表单校验提示（`NuxtForm` + `NuxtToast`）
  - 删除确认弹窗（`ConfirmDialog` 确认）
  - 加载状态（骨架屏 + loading spinner）
  - 错误处理（`NuxtToast` 错误提示）
  - 响应式适配（侧边栏折叠，DashboardSidebar collapsible）
- [x] 部署文档
  - 生产构建命令（`bun run build`）
  - 启动命令（`bun run .output/server/index.mjs`）
  - 环境变量说明
  - Nginx 反向代理参考配置（SSE 关闭缓冲）
- [x] 全量测试

### 验收标准

- 总览页数据正确，快速入口可用
- 所有表单有校验和错误提示
- 删除操作有确认
- 移动端可用（侧边栏折叠为抽屉）
- 生产构建成功并可启动

---

## 依赖关系

```
Phase 0 (骨架)
    ↓
Phase 1 (数据层 + 实例管理)
    ↓
Phase 2 (连通性测试 + 导入导出)
    ↓
Phase 3 (文件分发)
    ↓
Phase 4 (总览 + 收尾)
```

Phase 0 → 1 是硬依赖（需要布局和路由）。
Phase 1 → 2 → 3 也是硬依赖（分发依赖实例数据，测试依赖 MinIO 封装）。
Phase 4 依赖 Phase 3 完成（总览需要分发结果数据）。

---

## 环境变量参考

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DISPATCH_CONCURRENCY` | `5` | 分发并发数 |
| `MINIO_DEFAULT_BUCKET` | `ndm` | 新建实例时 bucket 默认值 |
| `DATA_FILE_PATH` | `server/data/groups.json` | 数据文件路径 |

---

## 技术风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Bun S3Client 预签名 URL 在某些 MinIO 版本上不兼容 | 分发失败 | 已在 minio-operation 项目验证通过；保留 minio npm 包作为 fallback |
| SSE 在某些代理/防火墙后被缓冲 | 进度不实时 | 文档提示关闭代理缓冲；备用方案改用轮询 |
| groups.json 并发写损坏 | 数据丢失 | store.ts 互斥锁；后续迁移 SQLite |
| 大量实例（100+）时前端性能下降 | 卡顿 | MVP 不处理；后续加虚拟滚动 |
