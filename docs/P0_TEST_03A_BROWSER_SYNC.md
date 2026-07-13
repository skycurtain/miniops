# 提议 3A 测试清单：浏览器内实例间文件同步

> **测试对象**：对象浏览器 `/ops/browser` 的「同步到...」功能（Modal + 悬浮指示器）
>
> **后端 API**：`POST /api/sync` + `GET /api/sync/events`（SSE）
>
> **涉及文件**：`app/components/SyncTargetModal.vue`、`app/components/SyncFloatingIndicator.vue`、`app/composables/useSync.ts`、`app/pages/ops/browser/index.vue`
>
> **前置条件**：dev server 正常运行（`http://localhost:3000`），本地 MinIO 容器在线（`localhost:9000`）

---

## 一、环境准备

### 1.1 实例配置

当前 `server/data/groups.json` 含 3 个实例（均指向 `localhost:9000`）：

| 实例名 | 用途 |
|---|---|
| `localhost` | 源实例候选 |
| `localhost(副本)` | 目标实例候选 |
| `localhost(副本)(副本)` | 目标实例候选（多目标测试用） |

### 1.2 Bucket 与测试数据

| Bucket | 用途 | 已有内容（可选） |
|---|---|---|
| `test` | 源 bucket | `配置文件.json`(4B)、`NyaTerm_...setup.exe`(11MB)、`2025/`、`文件夹/`、若干特殊字符文件名 |
| `ndm` | 目标 bucket | 可为空 |

> 如需补充测试数据，用 `mc cp` 或浏览器上传功能添加。

### 1.3 验证工具

- **MinIO Console**：`http://localhost:9001`（minioadmin / minioadmin），用于目视核对目标对象
- **mc 命令**：`docker run --rm --entrypoint sh minio/mc:latest -c '...'`，用于精确验证对象存在性和内容

---

## 二、测试用例

### 用例 T1：基本同步流程（单个小文件）

**目标**：验证完整链路 select → scanning → progress → done，以及 Modal 各阶段 UI。

#### 步骤

1. 打开 `/ops/browser`
2. 「选择实例」下拉 → 选 `localhost`
3. 「选择 Bucket」→ 选 `test`
4. 对象列表中勾选 `配置文件.json`
5. 工具栏点「同步到...」按钮
6. 在弹出的 Modal 中展开「默认」组，勾选 `localhost(副本)`
7. 在 `localhost(副本)` 行的 bucket 下拉中手动选 `ndm`（该 MinIO 有 2 个 bucket，不会自动填充）
8. 在「目标前缀」输入框填 `synctest/`（隔离测试数据，便于测后清理）
9. 点「开始同步」

#### 判断标准

**A. Modal 选择阶段（select）**

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T1-A1 | 源信息区（只读） | 显示 `localhost` + endpoint + `test` +「选中：1 个对象 + 0 个文件夹」 | |
| T1-A2 | 目标实例树 `localhost` 行 | 灰色禁用，右侧黄色「源」badge，checkbox 不可勾 | |
| T1-A3 | 勾选 `localhost(副本)` 后 | 该行右侧出现 bucket 下拉，自动加载（转圈→`ndm`） | |
| T1-A4 | bucket 下拉 | 下拉框含 `ndm` 和 `test` 两个选项，需手动选 `ndm`（仅当目标 MinIO 上只有 1 个 bucket 时才自动填充，当前不满足） | |
| T1-A5 | 「开始同步」按钮 | 选好 bucket 后蓝色可点；未选 bucket 时灰色禁用 | |

**B. Modal 进度阶段（progress）**

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T1-B1 | Modal 切换到进度视图 | 显示「源: localhost / test → 目标: 1 个实例」 | |
| T1-B2 | 扫描动画 | 转圈 +「正在扫描源对象... 已发现 N 个」（小文件极快，可能一闪而过） | |
| T1-B3 | 实例折叠行 | `localhost(副本)` 行出现，默认展开 | |
| T1-B4 | 实例行进度 | 显示 `1/1`，进度条满 | |
| T1-B5 | 文件行状态 | 绿色 ✓ 图标 | |
| T1-B6 | 文件行 hover | tooltip 显示「成功 · XXXms」 | |
| T1-B7 | 底部按钮 | 只有「后台继续」可点 | |

**C. Modal 完成阶段（done）**

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T1-C1 | 顶部汇总 | 「共 1」+ 绿色「成功 1」+ 红色「失败 0」 | |
| T1-C2 | 总进度条 | 100% | |
| T1-C3 | 底部按钮 | 只剩蓝色「关闭」可点 | |
| T1-C4 | 点「关闭」后 | Modal 关闭。列表刷新实际在 SSE complete 事件时已触发（`@complete="loadObjects()"`），点关闭只是关 Modal | |

**D. 目标验证**

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T1-D1 | MinIO Console / mc 检查 | `ndm`（或指定前缀下）存在 `配置文件.json`，内容与源一致 | |

---

### 用例 T2：源实例禁用（边界校验）

**目标**：验证源实例不能作为同步目标。

#### 步骤

1. 勾选任意对象 → 点「同步到...」
2. 在 Modal 目标实例树中，尝试勾选 `localhost`（源实例）
3. 点组级全选 checkbox

#### 判断标准

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T2-1 | `localhost` 行 checkbox | 灰色不可勾 | |
| T2-2 | 组级全选 | 勾选后源实例**仍不选中**（只有非源实例被选中） | |
| T2-3 | 组级全选 indeterminate | 只勾选部分非源实例时，组 checkbox 显示半选状态 | |

---

### 用例 T3：组级批量 bucket

**目标**：验证多目标实例的组级 bucket 批量设置。

#### 步骤

1. 勾选任意对象 → 点「同步到...」
2. 勾选组级全选（选中 `localhost(副本)` 和 `localhost(副本)(副本)`）
3. 等待两个实例 bucket 加载完成
4. 点组行的「批量设 bucket」下拉

#### 判断标准

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T3-1 | 批量 bucket 下拉选项 | 只显示两个实例 bucket 的**交集**（因指向同一 MinIO，应含 `ndm`、`test`） | |
| T3-2 | 选一个 bucket | 组内两个实例的 bucket **同时**被设为该值 | |
| T3-3 | 实例级独立覆盖 | 之后单独改某个实例的 bucket，不影响另一个 | |

---

### 用例 T4：多文件 + 文件夹前缀递归

**目标**：验证跨前缀累积选择 + 文件夹递归展开扫描。

#### 步骤

1. 在 browser 进入 `test` bucket 根目录
2. 前缀跳转到 `2025/`，勾选其中的对象
3. 面包屑回到根目录，勾选 `文件夹/` 前缀（跨前缀累积）
4. 点「同步到...」→ 选目标 → 开始同步
5. 观察扫描阶段

#### 判断标准

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T4-1 | Modal 源区「选中」 | 显示「N 个对象 + M 个文件夹」 | |
| T4-2 | 扫描进度 | 「已发现」数字递增（文件夹递归展开，scan-progress 多次推送） | |
| T4-3 | 扫描完成总数 | = 直接勾选的对象数 + 文件夹递归展开的对象数 | |
| T4-4 | 文件行路径 | 按 `relativeKey`（相对路径）显示，如 `01/报告【第一季度】.xlsx` | |
| T4-5 | 目标目录结构 | MinIO Console 检查目标 bucket，目录层级完整保留 | |

---

### 用例 T5：大文件同步（触发 multipart）

**目标**：验证 >8MB 文件走流式 multipart 上传。

#### 步骤

1. 勾选 `test` 根下的 `NyaTerm_1.1.3_windows_x64-setup.exe`（11MB）
2. 点「同步到...」→ 选目标 → 开始同步

#### 判断标准

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T5-1 | 扫描完成总大小 | 显示约 11.40 MB | |
| T5-2 | 同步耗时 | 该文件转圈持续约 0.5-2s（比小文件久），然后变绿 ✓ | |
| T5-3 | 无报错 | 不出现红色 ❌ 或错误提示 | |
| T5-4 | 目标文件完整性 | mc 对比源/目标 MD5 一致 | |

---

### 用例 T6：有失败的同步（异常路径）

**目标**：验证错误处理和失败状态展示。

#### 准备

在 Modal 目标实例的 bucket 输入框中手动填一个**不存在的 bucket**名（如 `nonexistent`）。

> bucket 加载失败时，选择框会降级为手动 `NuxtInput`（见 `SyncTargetModal.vue:187`）。

#### 步骤

1. 勾选任意对象 → 点「同步到...」
2. 勾选目标实例，在 bucket 输入框填 `nonexistent`
3. 点「开始同步」

#### 判断标准

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T6-1 | 同步过程 | 文件行变红 ❌ | |
| T6-2 | 文件行 hover | tooltip 显示错误信息（如 `上传失败: 404 ...`） | |
| T6-3 | 完成汇总 | 红色「失败 N」badge，N>0 | |
| T6-4 | 实例行 | 显示红色「失败 N」badge | |
| T6-5 | 底部按钮 | done 阶段，蓝色「关闭」可点 | |

---

### 用例 T7：悬浮指示器（后台运行）

**目标**：验证关闭 Modal 后浮窗进度展示和交互。

#### 步骤

1. 发起一个多文件同步任务
2. 同步进行中点「后台继续」关闭 Modal
3. 观察右下角浮窗
4. 点击浮窗

#### 判断标准

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T7-1 | 浮窗出现 | 右下角卡片，显示「同步中 N/N」+ 进度条 | |
| T7-2 | 扫描阶段浮窗 | 显示「扫描中... N 个」 | |
| T7-3 | 点击浮窗 | 重新打开 Modal（回到进度视图） | |
| T7-4 | 全部成功且不点浮窗 | 同步完成后**自动弹出 Modal**显示结果汇总（done 阶段）；浮窗因 Modal 打开而卸载，不会触发自动淡出 | |
| T7-5 | 有失败时 | 浮窗黄色警告，**不自动淡出**；同步完成后同样自动弹出 Modal 显示结果 | |
| T7-6 | 有失败时手动关浮窗 | 点浮窗 ✕ 关闭 -> `sync.reset()` 清空状态；之后同步完成不再自动弹 Modal（taskSummary 已被 reset 清空） | |

---

### 用例 T8：Modal 反复打开（状态重置）

**目标**：验证一次同步完成后，再次打开 Modal 状态干净。

#### 步骤

1. 完成一次同步（用例 T1），点「关闭」
2. 重新勾选对象 → 点「同步到...」

#### 判断标准

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T8-1 | Modal 回到 select 阶段 | 不残留上次进度视图 | |
| T8-2 | 目标实例选择 | 已清空（无残留勾选） | |
| T8-3 | bucket 选择 | 已清空 | |
| T8-4 | 目标前缀 | 已清空 | |

---

### 用例 T9：凭据无效实例

**目标**：验证目标实例凭据错误时的降级处理。

#### 准备

先在「实例管理」页编辑 `localhost(副本)(副本)`，把 secretKey 改错一位，保存。

#### 步骤

1. 勾选任意对象 → 点「同步到...」
2. 勾选凭据无效的 `localhost(副本)(副本)`

#### 判断标准

| 编号 | 观察点 | 预期 | ✓/✗ |
|---|---|---|---|
| T9-1 | 实例行警告图标 | 右侧出现 ⚠ 三角警告 | |
| T9-2 | 警告 hover | tooltip 显示错误信息（如 `403 Forbidden` 或 `Access Denied`） | |
| T9-3 | bucket 输入降级 | 下拉框降级为手动输入框（`NuxtInput`），placeholder「输入 bucket」 | |

#### 恢复

测试完成后记得把 secretKey 改回正确值。

---

## 三、重点关注的潜在问题

以下几项是 API 测试覆盖不到、纯前端交互/时序相关的风险点，测试时优先关注：

| # | 风险点 | 关联代码 | 表现 |
|---|---|---|---|
| P1 | SSE 进度实时性 | `useSync.ts` `subscribeSSE` progress 事件处理 | 文件行状态从转圈到对勾/叉是否平滑，有无卡在转圈不动 |
| P2 | 实例折叠展开 | `SyncTargetModal.vue` `watch(modalPhase)` | 提交后实例行默认展开是否生效；手动折叠/再展开是否正常 |
| P3 | 浮窗自动淡出 | `SyncFloatingIndicator.vue` `watch(taskSummary)` | 全部成功 3 秒淡出--若卡住不消失，说明 `taskSummary.failed === 0` 判断或 timer 有问题 |
| P4 | 同步完成后列表刷新 | `browser/index.vue` `@complete="loadObjects()"` | 同步完成时（SSE complete 事件）browser 对象列表是否重新加载 |
| P5 | Modal 反复打开状态清理 | `useSync.ts` `reset()` | 同步完成后再次打开 Modal，是否彻底回到 select 阶段 |
| P6 | 跨前缀累积选择 | browser 页 `selectedKeys`/`selectedPrefixes` | 切换前缀后已选对象是否保留，Modal 源区计数是否正确 |
| P7 | 同步弹窗右上角 X | `SyncTargetModal.vue` `NuxtModal` 未设 `:close` | 进行中阶段右上角 X 仍可点击关闭（待后续对齐上传弹窗的隐藏模式，见 memory `sync-modal-close-control`） |

---

## 四、测试后清理

测试完成后，清理目标 bucket 中的测试数据：

```bash
docker run --rm --entrypoint sh minio/mc:latest -c 'mc alias set local http://host.docker.internal:9000 minioadmin minioadmin >/dev/null 2>&1; mc rm --recursive --force local/ndm/synctest/'
```

---

## 五、测试记录

| 用例 | 名称 | 结果 | 备注 |
|---|---|---|---|
| T1 | 基本同步流程 | ☐ 通过 ☐ 失败 | |
| T2 | 源实例禁用 | ☐ 通过 ☐ 失败 | |
| T3 | 组级批量 bucket | ☐ 通过 ☐ 失败 | |
| T4 | 多文件 + 文件夹递归 | ☐ 通过 ☐ 失败 | |
| T5 | 大文件 multipart | ☐ 通过 ☐ 失败 | |
| T6 | 有失败的同步 | ☐ 通过 ☐ 失败 | |
| T7 | 悬浮指示器 | ☐ 通过 ☐ 失败 | |
| T8 | Modal 反复打开 | ☐ 通过 ☐ 失败 | |
| T9 | 凭据无效实例 | ☐ 通过 ☐ 失败 | |

测试人：__________ 日期：__________

