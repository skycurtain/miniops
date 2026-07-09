# 提议 11 实施计划：连通性测试增强（凭据验证）

> **目标**：将连通性测试从"只测网络可达"升级为"网络可达 + 凭据有效"双重验证，让用户在分发前就能发现凭据错误。

---

## 一、现状分析

### 1.1 当前实现链路

```
前端 groups/index.vue
  ├ testOne()  -> POST /api/groups/:id/test?instanceId=xxx
  └ testAll()  -> POST /api/groups/:id/test
                        ↓
后端 test.post.ts -> testConnectivity() / testGroupConnectivity()
                        ↓
minio.ts testConnectivity()
  └ GET /minio/health/live  ← 无需鉴权，只验证进程存活+网络可达
```

### 1.2 当前 ConnectivityResult

```typescript
// server/utils/minio.ts
export interface ConnectivityResult {
  instanceId: string
  instanceName: string
  endpoint: string
  online: boolean       // 只有在线/离线两态
  latency?: number
  error?: string
}
```

### 1.3 当前前端展示

实例管理页连通性列，两态 badge：

```
在线 → [在线] 23ms     绿色 soft badge
离线 → [离线]          红色 outline badge + error 文字
```

### 1.4 已有的 listBuckets 能力

`server/utils/minio.ts` 中已实现 `listBuckets(instance)`，调用 S3 ListBuckets API（需 SigV4 签名鉴权），返回 `{ instanceId, buckets, error? }`。**无需新增任何签名代码**，直接复用。

### 1.5 分发页的 bucket 加载

分发页选中实例后调用 `loadBuckets()` -> `POST /api/instances/buckets` -> `listBucketsBatch()`。如果凭据无效，`listBuckets` 返回 `{ buckets: [], error: "HTTP 403: ..." }`，该 error 已存入 `BucketLoadState.error`，但前端只是静默回退为手动输入框，没有明确警告。

---

## 二、改动清单

### 2.1 后端（2 个文件）

| 文件 | 改动 |
|---|---|
| `server/utils/minio.ts` | `ConnectivityResult` 新增 `authValid` 字段；`testConnectivity()` 在 health/live 通过后追加 `listBuckets()` 调用 |
| `server/api/groups/[id]/test.post.ts` | 无需改动（已调用 `testConnectivity`，返回值自动包含新字段） |

### 2.2 前端（3 个文件）

| 文件 | 改动 |
|---|---|
| `app/pages/groups/index.vue` | `ConnectivityResult` 接口新增 `authValid` 字段；连通性列渲染改为三态；组标题新增聚合 badge |
| `app/pages/ops/dispatch/index.vue` | bucket 加载失败时显示内联凭据警告 |
| `app/composables/useDispatch.ts` | 无需改动（`BucketLoadState.error` 已存在，前端直接消费） |

**总计：2 个文件改动，0 个新增文件，0 条新增 API 路由。**

---

## 三、详细实现

### 3.1 后端：增强 ConnectivityResult 与 testConnectivity

#### 3.1.1 类型变更

```typescript
// server/utils/minio.ts

export interface ConnectivityResult {
  instanceId: string
  instanceName: string
  endpoint: string
  online: boolean
  latency?: number
  error?: string
  /** 凭据是否有效。仅 online=true 时有意义；undefined 表示未检测 */
  authValid?: boolean
  /** 凭据检测失败的错误信息 */
  authError?: string
}
```

#### 3.1.2 testConnectivity 逻辑变更

当前流程：
```
GET /minio/health/live
  ├ 200 → online: true
  ├ 非 200 → online: false, error: "HTTP xxx"
  └ 异常 → online: false, error: "连接失败/超时"
```

增强后流程：
```
GET /minio/health/live
  ├ 非 200 / 异常 → online: false, error: "..."（不变，authValid 留空）
  └ 200 → online: true
        ↓
        追加 listBuckets(instance)  ← 鉴权验证
          ├ 返回 buckets → authValid: true
          ├ 返回 error   → authValid: false, authError: 提取错误信息
          └ 超时(10s)    → authValid: false, authError: "凭据验证超时"
```

**关键实现细节：**

- health/live 仍用 5s 超时（现有逻辑不变）
- listBuckets 已有 10s 超时（现有逻辑），无需新增
- listBuckets 返回 error 时，需从 error 字符串中提取关键信息：
  - `"HTTP 403: ..."` → "凭据无效 (403 Access Denied)"
  - `"HTTP 401: ..."` → "认证失败 (401 Unauthorized)"
  - 其他 → 原样透传
- 最坏情况总耗时：5s(health) + 10s(listBuckets) = 15s，可接受

#### 3.1.3 伪代码

```typescript
export async function testConnectivity(instance: MinioInstance): Promise<ConnectivityResult> {
  // ... 现有 health/live 逻辑不变，拿到 online + latency ...

  // 如果在线，追加凭据验证
  if (result.online) {
    const bucketResult = await listBuckets(instance)
    if (bucketResult.error) {
      result.authValid = false
      result.authError = formatAuthError(bucketResult.error)
    } else {
      result.authValid = true
    }
  }

  return result
}
```

#### 3.1.4 错误信息格式化

```typescript
function formatAuthError(rawError: string): string {
  if (rawError.includes('403')) return '凭据无效 (403 Access Denied)'
  if (rawError.includes('401')) return '认证失败 (401 Unauthorized)'
  if (rawError.includes('超时')) return '凭据验证超时'
  return rawError
}
```

### 3.2 前端：实例管理页三态展示

#### 3.2.1 接口同步

```typescript
// app/pages/groups/index.vue
interface ConnectivityResult {
  instanceId: string
  instanceName: string
  endpoint: string
  online: boolean
  latency?: number
  error?: string
  authValid?: boolean    // 新增
  authError?: string     // 新增
}
```

#### 3.2.2 连通性列渲染逻辑

当前两态：
```
loading → spinner
无结果  → "-"
online  → [在线] 绿 + latency
离线    → [离线] 红 + error
```

增强后四态：
```
loading           → spinner
无结果            → "-"
online + authValid=true   → [在线·凭据有效] 绿 + latency
online + authValid=false  → [在线·凭据无效] 橙 + tooltip(authError)
online + authValid=undefined → [在线] 绿 + latency + "(未验证凭据)" 小字  ← 兜底
离线              → [不可达] 红 + tooltip(error)
```

**Badge 配色：**
| 状态 | color | variant | 文案 |
|---|---|---|---|
| 在线·凭据有效 | success | soft | 在线 |
| 在线·凭据无效 | warning | soft | 凭据无效 |
| 在线(未验证) | success | soft | 在线 |
| 不可达 | error | outline | 不可达 |

> 注：badge 文案保持简短（"在线"而非"在线·凭据有效"），凭据状态通过颜色 + 旁边的图标/文字区分，避免列宽不够。具体：凭据有效时正常显示 latency；凭据无效时 latency 位置改为橙色 `⚠️ 凭据无效`，hover tooltip 显示 authError。

#### 3.2.3 渲染函数改动

连通性列的 `cell` 渲染函数（`h()` 形式）改为：

```typescript
// 伪代码 - 实际用 h() 渲染
if (isLoading) → spinner（不变）
if (!r) → "-"（不变）

// 有结果
if (!r.online) {
  // 不可达：红色 badge + tooltip(error)
  [不可达] + tooltip: r.error
}
else if (r.authValid === false) {
  // 在线但凭据无效：橙色 badge + tooltip(authError)
  [在线] 橙色 + ⚠️ 图标 + tooltip: r.authError
}
else {
  // 在线且凭据有效（或未验证）：绿色 badge + latency
  [在线] 绿色 + latency
}
```

#### 3.2.4 组标题聚合 badge

"测试全部"完成后，组标题旁显示聚合状态。需新增 computed 或在 `testAll()` 完成后计算：

```
组A  3个启用  [2在线·1离线]  [测试全部]
              ↑ 新增聚合 badge
```

**聚合逻辑：**

```typescript
// 伪代码
function getGroupConnectivitySummary(g: InstanceGroup): { label: string; color: string } | null {
  const results = g.instances
    .filter(i => i.enabled)
    .map(i => connectivity.value[i.id])
    .filter(Boolean)
  if (!results.length) return null  // 未测试过

  const online = results.filter(r => r.online).length
  const offline = results.filter(r => !r.online).length
  const authFailed = results.filter(r => r.online && r.authValid === false).length

  if (offline > 0) return { label: `${online}在线·${offline}离线`, color: 'error' }
  if (authFailed > 0) return { label: `${online}在线·${authFailed}凭据异常`, color: 'warning' }
  return { label: `${online}在线`, color: 'success' }
}
```

**组标题渲染位置：**

在组行的 `g.instances.length` badge 后面追加聚合 badge，仅当该组已测试过时显示：

```html
<!-- 现有 -->
<NuxtBadge color="neutral" variant="subtle" size="sm">{{ g.instances.length }} 个实例</NuxtBadge>

<!-- 新增（仅 testAll 后显示） -->
<NuxtBadge v-if="getGroupConnectivitySummary(g)" :color="..." variant="soft" size="sm">
  {{ getGroupConnectivitySummary(g)?.label }}
</NuxtBadge>
```

### 3.3 前端：分发页凭据预检警告

#### 3.3.1 现状

分发页选中实例后，`loadBuckets()` 调用 `POST /api/instances/buckets`。凭据无效时 `BucketLoadState.error` 有值，但前端只是静默回退为手动输入框：

```html
<!-- 当前：error 时只显示手动输入框，无警告 -->
<NuxtInput v-else-if="dispatch.getInstanceBucketOptions(inst).error" ... />
```

#### 3.3.2 改动

在 bucket 输入区域前面增加内联警告，仅当 `error` 有值时显示：

```html
<!-- 改后：error 时显示警告 + 手动输入框 -->
<template v-if="isInstanceSelected(inst) && inst.enabled">
  <div class="flex items-center gap-1">
    <span class="text-xs text-muted">bucket</span>

    <!-- 新增：凭据警告 -->
    <NuxtTooltip v-if="dispatch.getInstanceBucketOptions(inst).error" :content="dispatch.getInstanceBucketOptions(inst).error">
      <NuxtIcon name="i-lucide-triangle-alert" class="size-4 text-warning" />
    </NuxtTooltip>

    <!-- loading / error(手动输入) / 正常下拉（逻辑不变） -->
    <NuxtIcon v-if="loading" ... />
    <NuxtInput v-else-if="error" ... />
    <NuxtSelectMenu v-else ... />
  </div>
</template>
```

#### 3.3.3 提交时提醒

在 `useDispatch.ts` 的 `submit()` 中，已有"部分实例未指定 bucket"的校验。在此校验之前增加凭据提醒：

```typescript
// submit() 中新增（在现有 bucket 校验之前）
const authFailed = selected.filter(inst => {
  const opts = instanceBucketOptions.value[inst.id]
  return opts?.error  // bucket 加载失败（通常是凭据问题）
})
if (authFailed.length) {
  const toast = useToast()
  toast.add({
    title: '部分实例凭据可能无效',
    description: authFailed.map(i => i.name).join('、'),
    color: 'warning',
  })
  // 不阻断，仅提醒，用户可选择继续
}
```

---

## 四、实施步骤

按以下顺序执行，每步可独立验证：

| 步骤 | 内容 | 验证方式 |
|---|---|---|
| 1 | 后端：`ConnectivityResult` 新增 `authValid` / `authError` 字段 | TypeScript 编译通过 |
| 2 | 后端：`testConnectivity()` 追加 `listBuckets()` 调用 | 手动 curl 测试，返回值含 `authValid` |
| 3 | 前端：`groups/index.vue` 接口同步 + 连通性列三态渲染 | 启动 dev，实例管理页测试单个实例，观察三态展示 |
| 4 | 前端：组标题聚合 badge | 测试全部后，组标题显示聚合状态 |
| 5 | 前端：分发页凭据警告 | 分发页选中凭据错误的实例，观察警告图标 |
| 6 | 前端：`submit()` 凭据提醒 toast | 选中凭据错误实例后点击分发，观察 toast |

---

## 五、验证矩阵

| 场景 | 预期结果 |
|---|---|
| 实例在线 + 凭据正确 | [在线] 绿 badge + latency，无警告 |
| 实例在线 + 凭据错误(403) | [在线] 橙 badge + ⚠️ 图标 + tooltip "凭据无效 (403 Access Denied)" |
| 实例在线 + 凭据超时 | [在线] 橙 badge + tooltip "凭据验证超时" |
| 实例不可达 | [不可达] 红 badge + tooltip 显示错误 |
| 实例未测试 | 连通性列显示 "-" |
| 测试全部（混合状态） | 组标题聚合 badge："2在线·1离线" 或 "3在线·1凭据异常" |
| 分发页选中凭据错误实例 | bucket 区域显示 ⚠️ 警告图标 |
| 分发页提交时含凭据错误实例 | toast 提醒"部分实例凭据可能无效"，不阻断提交 |
| 分发页凭据错误实例的 bucket | 回退为手动输入框（现有逻辑不变） |

---

## 六、不涉及的范围

- 不新增 API 路由
- 不新增前端页面
- 不修改 `listBuckets()` 函数本身（只调用它）
- 不修改 `testGroupConnectivity()`（它只是 `Promise.all(testConnectivity)`，自动继承增强）
- 不修改 `test.post.ts`（它只是透传 `testConnectivity` 返回值）
- 不修改 SSE / dispatcher / uploads 等无关模块
