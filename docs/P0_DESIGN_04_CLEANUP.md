# 提议 4 设计文档：跨实例批量清理 + 删除 SSE 进度

> **范围**：本文档覆盖提议 4 的两个待实现子项：
> - **② 跨实例批量清理**（核心）——选多个实例 + bucket + 前缀，一次清理 N 个实例上的同名/同前缀对象
> - **③ 删除走 SSE 进度推送**——大批量删除实时反馈进度
>
> **不在本次范围**：
> - ① 对象浏览器内单实例多选删除（提议 1 已实现，`POST /api/instances/objects/delete`）
> - ④ 分发失败回滚清理（依赖提议 2 分发历史记录，后续单独设计）

---

## 1. 设计目标

| 目标 | 说明 |
|---|---|
| 跨实例清理 | 错误分发到几十个实例后，一键选中所有目标实例 + 同一个 bucket + 前缀，批量删除，不用逐个登录 |
| 进度可见 | 大批量删除（数千对象 × N 实例）走 SSE 实时推送，不卡死请求、不盲等 |
| 安全防误删 | 删除前强制二次确认，显示对象列表 + 总大小 + 目标实例清单，"清理"二字 + 红色按钮 |
| 复用现有基建 | SSE 框架（taskRegistry + subscribeTask + createEventStream）、SigV4 删除函数（deleteObjects / deleteByPrefixes）全部复用 |

---

## 2. 页面入口与导航

### 2.1 独立页面：`/ops/cleanup`

在侧边栏「运维」分组下新增「批量清理」：

```
侧边栏:
  总览
  实例
  运维
    ├── 文件分发
    ├── 对象浏览
    └── 批量清理  ← 新增
```

`AppLayout.vue` navItems 新增：
```
{ label: '批量清理', to: '/ops/cleanup', icon: 'i-lucide-trash-2' }
```

### 2.2 为什么独立页面而不是嵌入对象浏览器

| 维度 | 嵌入对象浏览器 | 独立页面（选定） |
|---|---|---|
| 核心交互 | 单实例浏览 -> 多选 -> 删 | 多实例选中 -> 选 bucket -> 前缀过滤 -> 删 |
| 实例选择 | 单选下拉 | 多选 checkbox（组 + 实例两级） |
| 对象预览 | 需要（图片/文本/视频…） | 不需要（清理场景只看 key + 大小，不预览内容） |
| bucket | 从单实例动态加载 | 所有选中实例的 bucket 交集 |
| 前缀导航 | 面包屑逐层钻取 | 前缀输入框直接过滤（清理场景用户已知要删哪个前缀） |
| 进度 | 同步 HTTP，列表刷新 | SSE 实时进度（跨实例聚合） |

两者的交互形态差别太大，强行塞进同一个页面会让单实例浏览流程变得臃肿。独立页面职责清晰，且与 `/ops/dispatch`（分发）、`/ops/browser`（浏览）形成并列的运维三件套。

---

## 3. 页面布局

```
┌ 批量清理 ────────────────────────────────────────────────────┐
│                                                                │
│  批量清理                                                      │
│  跨实例批量删除 MinIO 对象，支持按前缀递归清理                  │
│                                                                │
│ ┌ 1. 选择目标实例 ──────────────────────────────────────────┐ │
│ │                                                            │ │
│ │  ☑ 全选                                                    │ │
│ │                                                            │ │
│ │  ┌ 节点组 A ─────────────────────────────────────────┐  │ │
│ │  │ ☑ 实例 1  (10.24.0.10:9000)   [bucket: config]│  │ │
│ │  │ ☑ 实例 2  (10.24.0.11:9000)   [bucket: config]│  │ │
│ │  │ ☐ 实例 4  (10.24.0.12:9000)   [未选择]        │  │ │
│ │  └──────────────────────────────────────────────────────┘  │ │
│ │  ┌ 节点组 B ─────────────────────────────────────────┐  │ │
│ │  │ ☑ 实例 3  (10.24.0.20:9000)   [bucket: config]│  │ │
│ │  │ ☐ 实例 5  (10.24.0.21:9000)   [未选择]        │  │ │
│ │  └──────────────────────────────────────────────────────┘  │ │
│ │                                                            │ │
│ │  已选 3 个实例                                              │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                │
│ ┌ 2. 选择 Bucket ───────────────────────────────────────────┐ │
│ │  [config ▾]  ← 选中实例的 bucket 交集下拉                  │ │
│ │  ⚠ 加载失败时可手动输入                                     │ │
│ │  说明：所有选中实例必须指定同一个 bucket 才能跨实例清理     │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                │
│ ┌ 3. 前缀过滤 ──────────────────────────────────────────────┐ │
│ │  前缀: [config/2025Q3/          ] [预览匹配对象]           │ │
│ │                                                            │ │
│ │  ☐ 同时删除子前缀（递归，不勾则只删当前层直接对象）        │ │
│ │  说明：留空则匹配 bucket 根下所有对象                       │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                │
│ ┌ 4. 预览匹配对象（可选）────────────────────────────────────┐ │
│ │                                                            │ │
│ │  以「实例 1」为参考实例预览匹配的对象：                 │ │
│ │                                                            │ │
│ │  ┌──────────────────────────────────────────────────────┐ │ │
│ │  │ ☑ config/2025Q3/device.json    4.5KB  2025-07-14     │ │ │
│ │  │ ☑ config/2025Q3/config.json    2.1KB  2025-07-15     │ │ │
│ │  │ ☐ config/2025Q3/layout.xml     1.2KB  2025-07-14     │ │ │
│ │  │ ☑ 📁 config/2025Q3/logs/       (递归)                 │ │ │
│ │  │   加载更多...                                       │ │ │
│ │  └──────────────────────────────────────────────────────┘ │ │
│ │                                                            │ │
│ │  ☑ 全选  已选 3/4 项                                        │ │
│ │                                                            │ │
│ │  预览说明：                                                 │ │
│ │  · 预览基于第一个选中实例的对象列表，其他实例按相同 key 删除│ │
│ │  · 各实例实际对象可能略有差异，删除时对不存在的 key 自动跳过│ │
│ │  · 勾选「递归」时文件夹下所有对象都会被删除                │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                │
│ ┌ 5. 执行 ──────────────────────────────────────────────────┐ │
│ │                        已选 3 个实例，4 个对象/前缀         │ │
│ │                                    [开始清理]  ← 红色按钮   │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                │
│ ┌ 6. 清理进度（执行后出现）──────────────────────────────────┐ │
│ │  正在清理...                              3/12             │ │
│ │  ████████░░░░░░░░                                           │ │
│ │                                                            │ │
│ │  ┌ 实例 1 ─────────────────────────────────────────┐  │ │
│ │  │ config (10.24.0.10:9000)         3/4  ████░░        │  │ │
│ │  │  ✅ config/2025Q3/device.json    已删除              │  │ │
│ │  │  ⏳ config/2025Q3/config.json    删除中...           │  │ │
│ │  │  ⬜ config/2025Q3/logs/          等待中              │  │ │
│ │  └──────────────────────────────────────────────────────┘  │ │
│ │  ┌ 实例 2 ─────────────────────────────────────────┐  │ │
│ │  │ config (10.24.0.11:9000)         2/4  ███░░░        │  │ │
│ │  │  ✅ config/2025Q3/device.json    已删除              │  │ │
│ │  │  ❌ config/2025Q3/config.json    失败: Access Denied  │  │ │
│ │  │  ...                                                │  │ │
│ │  └──────────────────────────────────────────────────────┘  │ │
│ │  ┌ 实例 3 ─────────────────────────────────────────┐  │ │
│ │  │ config (10.24.0.20:9000)         1/4  ██░░░░        │  │ │
│ │  │  ...                                                │  │ │
│ │  └──────────────────────────────────────────────────────┘  │ │
│ │                                                            │ │
│ │  完成后:                                                    │ │
│ │  共 12 个操作，成功 10，失败 2          [重新清理]         │ │
│ └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

---

## 4. 交互流程详解

### 4.1 第 1 步：选择目标实例

**布局**：按实例组分组，每组一个折叠卡片（默认展开），组内实例逐行 checkbox。

**选择逻辑**（复用分发页的模式）：
- 组级 checkbox：全选/取消组内所有 enabled 实例（indeterminate 状态支持）
- 全选 checkbox：选中所有组的全部 enabled 实例
- 每个实例行旁边显示该实例当前选中的 bucket（从 bucket 交集加载结果中取）

**与分发页的差异**：
- 分发页的实例选择和 bucket 选择是耦合的（每个实例可指定不同 bucket）
- 清理页要求所有实例用**同一个 bucket**（跨实例清理 = 删 N 个实例上同 bucket 同 key 的对象）
- 因此 bucket 选择提升为第 2 步全局选择，不在实例行内单独指定

**Bucket 预加载**：选中实例后自动调 `POST /api/instances/buckets` 批量加载 bucket 列表（复用现有接口），用于第 2 步的交集计算。

### 4.2 第 2 步：选择 Bucket

**候选列表**：所有选中实例已加载 bucket 列表的**交集**。

```
实例 A buckets: [config, data, backup]
实例 B buckets: [config, data]
实例 C buckets: [config, logs]
→ 交集: [config]
```

**交互**：
- NuxtSelectMenu 下拉，选项为交集 bucket 列表
- 如果交集为空：显示提示"选中实例没有公共 bucket，请调整实例选择"
- 如果某个实例 bucket 加载失败：显示 ⚠ 图标 + 允许手动输入 bucket 名（兜底，与对象浏览器一致）
- 选定 bucket 后，第 3 步前缀过滤区解除禁用

### 4.3 第 3 步：前缀过滤

**前缀输入框**：自由输入，如 `config/2025Q3/`。

**清洗逻辑**（复用 `sanitizeObjectKey` 的规则）：
- 反斜杠归一化为正斜杠
- 去除段首点（`.`）
- 过滤 `..` 路径遍历
- 自动补尾斜杠（输入 `config/2025Q3` → `config/2025Q3/`）
- 留空 = 匹配 bucket 根下所有对象

**递归开关**：
- ☑ 勾选（默认）：删除前缀下所有对象（含子前缀递归），用 `delimiter=""` 列出
- ☐ 不勾：只删当前前缀层的直接对象（`delimiter="/"` 列出，仅删 Contents 不删 CommonPrefixes）

**预览按钮**：点击后调 `POST /api/instances/objects/list`（以第一个选中实例为参考），加载匹配对象列表到第 4 步。

### 4.4 第 4 步：预览匹配对象（可选但推荐）

**参考实例**：取选中实例列表的第一个（或用户可切换），调 listObjects 展示该实例在前缀下的对象列表。

**展示内容**：
- 对象行：checkbox + 图标 + key（截断显示当前前缀后的部分）+ 大小 + 修改时间
- 文件夹行（CommonPrefixes）：checkbox + 📁 图标 + 前缀名 + "（递归）"标记
- 分页：加载更多（continuationToken）

**选择逻辑**（复用对象浏览器的多选模式）：
- 全选/取消当前页
- 对象和文件夹分别用 selectedKeys / selectedPrefixes 两个 Set 管理
- 选中计数显示"已选 N 项（含 M 个文件夹）"

**预览说明区域**（重要，防止误解）：
```
预览说明：
· 预览基于「实例 1」的对象列表，其他实例按相同 key 删除
· 各实例实际对象可能略有差异，删除时对不存在的 key 自动跳过
· 勾选「递归」时文件夹下所有对象都会被删除
```

**不提供预览的快捷模式**：
如果用户不点"预览匹配对象"，直接在「执行」步骤点"开始清理"，则按以下规则执行：
- 有前缀 + 递归勾选 → 删除所有选中实例上该前缀下的全部对象（等价于全选预览结果）
- 有前缀 + 递归不勾 → 删除所有选中实例上该前缀层的直接对象
- 无前缀 → 删除所有选中实例上 bucket 内全部对象（高危，需额外确认）

### 4.5 第 5 步：执行——确认弹窗

点击「开始清理」后弹出 ConfirmDialog，必须显示完整信息：

```
┌ 确认清理 ──────────────────────────────────────────────────┐
│                                                              │
│  ⚠️ 即将在 3 个实例上清理对象                                │
│                                                              │
│  清理范围:                                                   │
│    • Bucket: config                                          │
│    • 前缀: config/2025Q3/（递归）                            │
│    • 对象/文件夹: 3 项（含 1 个文件夹）                      │
│                                                              │
│  目标实例:                                                   │
│    • 实例 1 (10.24.0.10:9000)                            │
│    • 实例 2 (10.24.0.11:9000)                            │
│    • 实例 3 (10.24.0.20:9000)                            │
│                                                              │
│  此操作不可恢复。                                             │
│                                                              │
│                        [取消]  [确认清理]  ← 红色            │
└──────────────────────────────────────────────────────────────┘
```

**高危场景额外确认**（无前缀 = 清空整个 bucket）：
```
┌ ⚠️ 高危操作 ───────────────────────────────────────────────┐
│                                                              │
│  你即将清空 3 个实例上的 config bucket 中的全部对象！       │
│                                                              │
│  这将删除所有对象，且不可恢复。                              │
│                                                              │
│  请输入 bucket 名称 "config" 以确认：                        │
│  [________________________]                                  │
│                                                              │
│                        [取消]  [确认清空]                    │
└──────────────────────────────────────────────────────────────┘
```

### 4.6 第 6 步：清理进度（SSE）

确认后，前端 POST 提交清理任务，后端返回 taskId，前端通过 SSE 订阅进度。

**进度展示**：实例级聚合折叠视图（复用分发页的进度模式）。

```
┌ 清理进度 ──────────────────────────────────────────────────┐
│  正在清理...                              3/12              │
│  ████████░░░░░░░░                                           │
│                                                              │
│  ┌ ▾ 实例 1 (10.24.0.10:9000) ────────────────────────┐│
│  │  config bucket                          3/4  ████░░     ││
│  │  ✅ config/2025Q3/device.json          已删除           ││
│  │  ✅ config/2025Q3/config.json          已删除           ││
│  │  ⏳ config/2025Q3/layout.xml           删除中...        ││
│  │  ⬜ 📁 config/2025Q3/logs/             等待中           ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌ ▾ 实例 2 (10.24.0.11:9000) ────────────────────────┐│
│  │  config bucket                          2/4  ███░░░     ││
│  │  ✅ config/2025Q3/device.json          已删除           ││
│  │  ❌ config/2025Q3/config.json          失败: Access Denied││
│  │  ...                                                     ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌ ▶ 实例 3 (10.24.0.20:9000) ────────────────────────┐│
│  │  config bucket                          1/4  ██░░░░     ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**完成后**：
```
┌ 清理完成 ──────────────────────────────────────────────────┐
│  共 12 个操作，成功 10，失败 2          [重新清理]         │
│                                                              │
│  ❌ 失败明细:                                                │
│    • 实例 2 / config/2025Q3/config.json: Access Denied  │
│    • 实例 2 / config/2025Q3/logs/: 列出对象失败          │
└──────────────────────────────────────────────────────────────┘
```

**进度展示规则**：
- 总进度 = 所有实例已完成数 / 总操作数
- 每个实例折叠卡片：实例名 + endpoint + 完成数/总数 + 进度条 + 失败计数
- 展开后显示每个对象/前缀的删除状态：✅ 已删除 / ⏳ 删除中 / ❌ 失败（含错误信息） / ⬜ 等待中
- 失败实例行用红色标记，完成后可展开查看失败明细

---

## 5. 后端设计

### 5.1 新增类型（`server/types/index.ts`）

```ts
/** 清理任务请求 */
export interface CleanupRequest {
  /** 目标实例 ID 列表 */
  instanceIds: string[]
  /** 目标 bucket（所有实例共用） */
  bucket: string
  /** 前缀（留空 = bucket 根） */
  prefix?: string
  /** 是否递归删除子前缀 */
  recursive?: boolean
  /** 要删除的具体对象 key 列表（来自预览勾选，可选） */
  keys?: string[]
  /** 要递归删除的文件夹前缀列表（来自预览勾选，可选） */
  prefixes?: string[]
}

/** 单个对象清理结果 */
export interface CleanupResult {
  instanceId: string
  instanceName: string
  /** 对象 key 或文件夹前缀 */
  target: string
  /** 是文件夹前缀还是单个对象 */
  targetType: 'object' | 'prefix'
  status: 'success' | 'failed'
  error?: string
  /** 删除的对象数（文件夹递归时可能 >1） */
  deletedCount?: number
  duration?: number
}

/** 清理任务 */
export interface CleanupTask {
  id: string
  request: CleanupRequest
  status: 'pending' | 'running' | 'done'
  resolvedInstances: MinioInstance[]
  results: CleanupResult[]
  createdAt: string
  finishedAt?: string
}
```

### 5.2 清理执行器（`server/utils/cleanup.ts`）

新建 `server/utils/cleanup.ts`，结构与 `dispatcher.ts` 对称：

```ts
/**
 * 清理执行器
 *
 * - 内存任务注册表：taskId -> CleanupTask + 事件订阅者
 * - 实例维度并发（复用 CONCURRENCY 或独立 CLEANUP_CONCURRENCY）
 * - 每个实例内：先解析 keys + prefixes，逐批 deleteObjects / deleteByPrefixes
 * - 每个对象/前缀删除完通过 SSE 推送进度
 */
```

**执行逻辑**：

```
executeCleanup(task):
  1. 解析删除目标：
     - 如果 request.keys / request.prefixes 有值（来自预览勾选）→ 用这些
     - 否则（无预览直接清理）：
       - recursive=true: deleteByPrefixes([prefix || ''])  → 递归删全部
       - recursive=false: listObjects(prefix, '/') → 只删 Contents 的 key
  2. 实例维度并发（CONCURRENCY），实例内串行：
     - 对每个实例：
       a. 如果有 keys → deleteObjects(instance, bucket, keys)（分批 1000）
       b. 对每个 prefix → deleteByPrefixes(instance, bucket, [prefix])
       c. 每批完成后 notify SSE
  3. 全部完成 → notify complete + summary
  4. 延迟 60s 清理任务注册表
```

**SSE 事件格式**（与 dispatch 对齐）：

```
event: start     data: {"type":"start","taskId":"..."}
event: progress  data: {"type":"progress","taskId":"...","result":{instanceId,instanceName,target,targetType,status,error?,deletedCount?,duration?}}
event: complete  data: {"type":"complete","taskId":"...","summary":{total,success,failed}}
```

**复用 dispatcher 的 SSE 基建**：

有两个方案：

**方案 A（推荐）：cleanup.ts 独立任务注册表 + 复用 events SSE 端点**

cleanup.ts 有自己的 `taskRegistry`（Map<string, CleanupTaskEntry>），但 SSE 订阅走同一个 `/api/dispatch/events` 端点——只需让 `subscribeTask` 能同时处理 dispatch 和 cleanup 两种任务。

实现方式：将 dispatcher.ts 的 `subscribeTask` / `notify` / `getTask` 泛型化，或提取公共的 task registry 模块。

**方案 B：cleanup.ts 完全独立，新增 `/api/cleanup/events` SSE 端点**

cleanup.ts 自带 `subscribeCleanupTask`，新增 `server/api/cleanup/events.get.ts`。

→ **选择方案 B**，原因：
1. dispatch 和 cleanup 的任务结构不同（DispatchTask vs CleanupTask），强行泛型化增加复杂度
2. 独立端点职责清晰，URL 语义明确（`/api/cleanup/events` vs `/api/dispatch/events`）
3. 代码复制量很小（events.get.ts 只有 ~20 行）

### 5.3 API 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/cleanup` | 提交清理任务，返回 `{ taskId }`，202 Accepted |
| GET | `/api/cleanup/events?taskId=xxx` | SSE 进度推送 |

**`POST /api/cleanup`**（`server/api/cleanup/index.post.ts`）：

```ts
/**
 * 请求体: CleanupRequest
 * 响应: 202 { taskId: "cleanup-xxx" }
 *
 * 后端立即创建任务并返回 taskId，后台异步执行。
 * 前端通过 GET /api/cleanup/events?taskId=xxx 订阅进度。
 */
```

校验逻辑：
- `instanceIds` 非空，且都是 enabled 实例
- `bucket` 非空
- 如果 `keys` 和 `prefixes` 都为空，则需要 `prefix`（或显式确认清空 bucket）
- 高危场景（无前缀 = 清空 bucket）可在此处做额外日志记录

**`GET /api/cleanup/events`**（`server/api/cleanup/events.get.ts`）：

结构与 `dispatch/events.get.ts` 完全对称，订阅 `cleanup.ts` 的 `subscribeCleanupTask`。

### 5.4 对象浏览器单实例删除的 SSE 改造（范围 ③）

当前对象浏览器（`/ops/browser`）的删除是同步 HTTP（`POST /api/instances/objects/delete`），大批量删除时无进度反馈。

**改造方案**：

将对象浏览器的批量删除也接入 SSE 进度框架。有两种实现路径：

**路径 A（推荐）：对象浏览器批量删除复用 cleanup 任务**

当对象浏览器的 `deleteSelected()` 删除对象数 > 阈值（如 50 个）时，改为提交 cleanup 任务（单实例），走 SSE 进度。小批量（≤50）仍走同步 HTTP 保持响应速度。

优点：
- 不新增后端端点，cleanup 任务天然支持单实例
- 用户在大批量删除时获得进度反馈

缺点：
- 对象浏览器需要引入 SSE 订阅逻辑（当前没有）
- 删除完成后需要刷新对象列表

**路径 B：保持对象浏览器删除为同步 HTTP，仅跨实例清理走 SSE**

对象浏览器的删除通常量不大（用户在浏览器里手动勾选），同步 HTTP + loading 态足够。SSE 进度只用于跨实例清理场景。

→ **选择路径 B**，原因：
1. 对象浏览器删除场景的对象数通常可控（用户手动勾选），同步 HTTP 体验已足够
2. `deleteByPrefixes` 已有 10000 上限保护，不会无限阻塞
3. 减少改动范围，避免给对象浏览器引入 SSE 复杂度
4. 跨实例清理才是真正需要 SSE 的场景（N 实例 × M 对象，量级大）

**结论：范围 ③ 的 SSE 进度推送仅作用于跨实例清理页面，不改造对象浏览器的现有删除流程。**

---

## 6. 前端实现

### 6.1 新增文件

| 文件 | 说明 |
|---|---|
| `app/pages/ops/cleanup/index.vue` | 批量清理页面 |
| `app/composables/useCleanup.ts` | 清理逻辑 composable（状态管理 + SSE 订阅） |

### 6.2 `useCleanup.ts` 结构

参照 `useDispatch.ts` 的模式：

```ts
export function useCleanup() {
  // 选中的实例 ID
  const selectedInstanceIds = ref<Set<string>>(new Set())
  // 选中的 bucket
  const selectedBucket = ref<string>('')
  // 前缀
  const prefix = ref<string>('')
  // 递归开关
  const recursive = ref<boolean>(true)

  // 预览状态
  const previewObjects = ref<ObjectInfo[]>([])
  const previewPrefixes = ref<string[]>([])
  const selectedKeys = ref<Set<string>>(new Set())
  const selectedPrefixes = ref<Set<string>>(new Set())

  // 进度
  const progress = ref<Record<string, CleanupResult | 'running' | null>>({})
  const isRunning = ref(false)
  const taskSummary = ref<{ total: number; success: number; failed: number } | null>(null)

  // cellKey: instanceId::target
  function cellKey(instanceId: string, target: string): string { ... }

  // 提交清理任务
  async function submit(groups: InstanceGroup[]) {
    // 1. 校验：实例/bucket/目标
    // 2. POST /api/cleanup → 拿 taskId
    // 3. new EventSource(`/api/cleanup/events?taskId=${taskId}`)
    // 4. 监听 start / progress / complete
  }

  // 实例级聚合进度
  function getInstanceProgress(instanceId: string, targets: string[]) { ... }

  return { selectedInstanceIds, selectedBucket, prefix, recursive, ... }
}
```

### 6.3 页面组件结构

```vue
<template>
  <div class="flex flex-col gap-6">
    <!-- 页头 -->
    <!-- 1. 选实例（组折叠 + checkbox 两级）-->
    <!-- 2. 选 bucket（交集下拉）-->
    <!-- 3. 前缀过滤 + 递归开关 + 预览按钮 -->
    <!-- 4. 预览对象列表（可选）-->
    <!-- 5. 执行栏 -->
    <!-- 6. 进度区（SSE，实例级折叠）-->
  </div>
</template>
```

### 6.4 导航入口

`AppLayout.vue` navItems 新增：

```ts
{
  label: '运维',
  icon: 'i-lucide-wrench',
  defaultOpen: true,
  children: [
    { label: '文件分发', to: '/ops/dispatch', icon: 'i-lucide-send' },
    { label: '对象浏览', to: '/ops/browser', icon: 'i-lucide-folder-search' },
    { label: '批量清理', to: '/ops/cleanup', icon: 'i-lucide-trash-2' },  // 新增
  ],
},
```

---

## 7. 关键设计决策

### 7.1 实例选择：组 + 实例两级 checkbox（不提供"选组 + 排除个别"）

**选定方案**：组级 checkbox 全选/取消组内 enabled 实例 + 实例级 checkbox 单独勾选。

**理由**：
- 与分发页的实例选择模式完全一致，用户认知零成本
- "选组 + 排除个别"本质上是组级全选后再取消个别，两级 checkbox 天然支持这个操作
- 不需要额外的"排除"交互

### 7.2 Bucket：全局单选（交集），不支持按实例指定不同 bucket

**选定方案**：所有选中实例共用同一个 bucket，候选列表为交集。

**理由**：
- 跨实例清理的语义是"删 N 个实例上同 bucket 同 key 的对象"，不同 bucket 没有清理意义
- 分发页支持按实例指定不同 bucket 是因为分发场景不同实例可能用途不同（如 A 实例存 config，B 实例存 data）
- 清理场景不需要这种灵活性，全局单选更简洁、更安全（减少误操作）

### 7.3 预览：以第一个选中实例为参考，不逐实例预览

**选定方案**：预览只查第一个选中实例的对象列表，其他实例按相同 key 删除。

**理由**：
- 逐实例预览需要 N 次 listObjects 调用，N 个实例的对象列表展示也极复杂
- 清理场景用户已知要删什么（前缀 + key 模式），预览只是确认范围
- 各实例对象差异在删除时自动处理（不存在的 key 跳过，DeleteMultipleObjects API 天然支持）
- 预览说明区域已明确告知用户"其他实例按相同 key 删除，对不存在的 key 自动跳过"

**参考实例可切换**：预览区顶部提供一个实例下拉，用户可切换参考实例重新预览（应对第一个实例对象不全的情况）。

### 7.4 删除模式：支持"精确勾选"和"按前缀全删"两种

**模式 A — 精确勾选**（通过预览）：
- 用户预览对象列表后勾选具体对象/文件夹
- 提交时带 `keys` + `prefixes`，后端按精确列表删除

**模式 B — 按前缀全删**（不预览，直接清理）：
- 用户只填前缀 + 勾选递归，不点预览
- 提交时不带 `keys` / `prefixes`，后端按 `prefix` + `recursive` 自行列出并删除
- 等价于"全选预览结果"

两种模式覆盖不同用户习惯：谨慎用户先预览再勾选，熟练用户直接按前缀清理。

### 7.5 递归删除安全上限

- `deleteByPrefixes` 已有 `RECURSIVE_DELETE_LIMIT = 10000` 上限
- 跨实例清理时，每个实例的每个前缀独立计算上限
- 超限时该实例该前缀标记为 failed，错误信息"文件夹下对象过多（>10000），请缩小范围后重试"
- 不阻断其他实例/前缀的清理

### 7.6 并发控制

- 实例维度并发：`CLEANUP_CONCURRENCY`（默认 5，与 dispatch 一致）
- 实例内删除串行：先删 keys（分批 1000），再逐个删 prefixes
- 不做对象级并发（deleteObjects 已是批量 API，一次最多 1000 个）

---

## 8. 与现有功能的关系

### 8.1 与对象浏览器（提议 1）的关系

| 功能 | 对象浏览器 | 批量清理页 |
|---|---|---|
| 实例选择 | 单选 | 多选 |
| 用途 | 浏览 + 预览 + 下载 + 偶尔删除 | 纯删除，跨实例批量 |
| 删除方式 | 同步 HTTP | SSE 进度 |
| 对象预览 | 有（图片/文本/视频…） | 无（只看 key + 大小） |
| bucket | 单实例动态加载 | 多实例交集 |

**互补关系**：对象浏览器适合"看一个实例里有什么，顺便删几个"；批量清理适合"错误分发到 N 个实例后，一次性清理"。

### 8.2 与分发（dispatch）的关系

- 分发的实例选择、bucket 加载、SSE 进度模式全部可复用
- 典型工作流：分发 → 发现错误 → 进入批量清理 → 选同一批实例 + bucket + 前缀 → 清理
- 未来提议 2（分发历史）实现后，可在分发历史卡片上加"清理此次分发"快捷入口，自动填充实例 + bucket + 前缀

### 8.3 与分发失败回滚清理（提议 4 ④）的关系

④ 依赖提议 2（分发历史记录），本次不实现。但本次设计的 cleanup 任务框架天然支持 ④：
- 提议 2 实现后，分发历史卡片加"清理此次分发"按钮
- 点击后跳转到 `/ops/cleanup`，URL 参数携带 `instanceIds` + `bucket` + `prefix`
- cleanup 页面从 URL 读取参数自动填充，用户确认后执行清理

---

## 9. 安全性

### 9.1 删除前确认

- 所有清理操作必须经过 ConfirmDialog 二次确认
- 确认弹窗显示：对象/前缀列表 + 总大小 + 目标实例清单
- 高危场景（无前缀 = 清空 bucket）需输入 bucket 名确认

### 9.2 路径遍历防护

- 前缀输入复用 `sanitizeObjectKey` 的清洗逻辑（反斜杠归一化、去段首点、过滤 `..`）
- 后端 `POST /api/cleanup` 再次校验前缀合法性

### 9.3 递归删除上限

- `deleteByPrefixes` 的 10000 上限保护，防误删超大规模数据
- 超限不阻断，标记 failed 并提示用户缩小范围

### 9.4 审计日志（预留）

- 当前不实现审计日志（依赖提议 8）
- cleanup 任务的 `CleanupTask` 结构已包含完整信息（谁删了哪些实例的哪些对象），未来可持久化到审计日志

---

## 10. 实现清单

### 后端

| 文件 | 动作 | 说明 |
|---|---|---|
| `server/types/index.ts` | 新增 | `CleanupRequest` / `CleanupResult` / `CleanupTask` 类型 |
| `server/utils/cleanup.ts` | 新建 | 清理执行器（任务注册表 + SSE notify + executeCleanup） |
| `server/api/cleanup/index.post.ts` | 新建 | `POST /api/cleanup` 提交清理任务 |
| `server/api/cleanup/events.get.ts` | 新建 | `GET /api/cleanup/events` SSE 端点 |

### 前端

| 文件 | 动作 | 说明 |
|---|---|---|
| `app/composables/useCleanup.ts` | 新建 | 清理状态管理 + SSE 订阅 composable |
| `app/pages/ops/cleanup/index.vue` | 新建 | 批量清理页面 |
| `app/components/AppLayout.vue` | 修改 | navItems 新增「批量清理」入口 |

### 不改动

- `server/utils/minio.ts` — `deleteObjects` / `deleteByPrefixes` / `listObjects` 全部复用，不改动
- `server/api/instances/objects/delete.post.ts` — 对象浏览器单实例删除保持同步 HTTP
- `app/pages/ops/browser/index.vue` — 对象浏览器不改动
- `server/utils/dispatcher.ts` — 分发执行器不改动

---

## 11. 开放问题（待讨论）

1. **清理任务的持久化**：当前 dispatch 任务也是内存态（重启丢失），cleanup 任务同样。是否需要持久化到文件以备审计？→ 建议等提议 8（审计日志）一起做。

2. **清理限流**：是否需要限制同时运行的清理任务数？→ 当前单用户场景不需要，未来多用户时再加。

3. **预览参考实例的选择**：默认用第一个选中实例，是否需要更智能的选择（如对象数最多的实例）？→ 建议先用第一个 + 可手动切换，够用。

4. **清理完成后的行为**：是否自动跳转回对象浏览器查看结果？→ 建议不跳转，在当前页展示完成摘要 + 失败明细，用户自行决定下一步。
