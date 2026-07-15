# miniops 后续改进与待办

> 本文档记录所有已识别但尚未实施的改进项、待排查 bug 和未来提议。
>
> 每项包含：**背景**、**目标**、**实现要点**、**优先级**、**状态**。

---

## 一、待排查 Bug

### BUG-1：连通性测试报凭据无效（真实 MinIO 环境）

**状态**：⏳ 待排查（需接入测试环境）

**现象**：在测试环境添加新组和新实例，填写的用户名和密码都正确，但连通性测试反馈"凭据无效 (403 Access Denied)"。

**关键判断**：与 Bun 运行时切换无关。本机 Docker MinIO 测试通过（签名逻辑正确），第一次连真实 MinIO 就出现 403。

**用户环境**：系统代理开启（Clash `127.0.0.1:7897`），通过路由表区分 WiFi（互联网）和网线（内网）。

**排查方向**（按优先级）：
1. MinIO 服务端日志：看 403 的具体原因（SignatureDoesNotMatch / InvalidAccessKeyId / AccessDenied）
2. 网络代理验证：确认 Clash 是否 TUN 模式；临时关代理后再测连通性
3. curl 直连对比：在测试环境用 `curl -v` 直接请求 MinIO health/live 和 ListBuckets
4. 凭据确认：在 MinIO Console 用相同凭据登录
5. region 差异：代码硬编码 `region: 'us-east-1'`，确认真实 MinIO 的 region 配置

---

## 二、技术债改进

### TD-1：后端任务取消能力（dispatcher + sync 统一支持 cancel）

**状态**：⬜ 待实施

**优先级**：低

**背景**：当前 `dispatcher.ts` 和 `sync.ts` 的任务框架不支持取消。提交后任务会一直跑完，用户无法中途终止。大批量任务（几百文件 × 多实例）可能要几十分钟，无法中途取消。

**目标**：用户提交大批量分发/同步任务后，跑到一半发现选错文件或选错目标，能立刻取消，剩余文件不再处理。

**实现要点**（dispatcher 和 sync 框架同构，必须一起改）：
- taskRegistry 加取消标志
- `processInstance` / `processInstanceSync` 循环里检查标志，提前退出
- 新增 API（如 `POST /api/dispatch/:id/cancel`、`POST /api/sync/:id/cancel`）
- SSE 推送 cancel 事件，前端感知
- 边界处理：正在上传中的文件传完还是中断、已上传的要不要回滚

### TD-2：评估改用 Bun 专有 API 替代 Node 标准库

**状态**：⬜ 待讨论

**优先级**：低

**背景**：运行时已统一为 Bun（dev 用 `bunx --bun nuxt dev`、生产用 `nitro: { preset: 'bun' }`），dev 和生产都跑在 Bun 上。当前代码全部用 `node:fs`、`node:crypto` 等 Node 标准库，Bun 完全兼容，但也可以改用 Bun 原生 API 获得更好性能。

**可改的点**（参考 market-x 项目的做法）：
- `node:crypto` 的 `createHash` → `Bun.CryptoHasher.hash('sha256', s, 'hex')`
- `node:fs` 的文件读写 → `Bun.file()` / `Bun.write()`
- UUID → `Bun.randomUUIDv7()`
- 短延时 → `Bun.sleep(ms)`
- 需加 `@types/bun` 到 devDependencies

**注意**：改动面较大，需评估收益。代码当前用 Node API 在 Bun 下完全正常工作。

---

## 三、已完成的主线待办（供参考）

以下是提议 3 阶段 1（实例间快捷同步）完成后清理的待办列表，现已全部完成：

| # | 待办项 | 状态 |
|---|---|---|
| 0 | 导航菜单顺序调整（对象浏览移至文件分发前） | ✅ 已完成 |
| 1 | 同步弹窗关闭控制（对齐上传弹窗的 dismissible/close） | ✅ 已完成 |
| 2 | 运行时统一（全切 Bun：dev + 生产 + 包管理） | ✅ 已完成 |
| 3 | XML 解析重构（fast-xml-parser 替换手搓 regex） | ✅ 已完成 |

---

## 四、未来功能提议

> 以下提议尚未立项，待主线待办清理完毕后讨论。

### 提议 3 阶段 2：独立同步页面 /ops/sync

**状态**：⬜ 待实施（排最后）

**背景**：提议 3 阶段 1（浏览器快捷同步）已完成，当前同步入口在对象浏览器内。阶段 2 计划做独立的同步页面，支持更复杂的同步场景（如跨组同步、定时同步等）。

### 提议 14：Bucket 管理

**状态**：⬜ 待讨论

**背景**：用户在实现同步时提出希望平台内支持 bucket 创建/删除。当前 miniops 只能选择已有 bucket，不能在平台内创建或删除 bucket。

**实现要点**：
- S3 协议有 `CreateBucket` / `DeleteBucket` API，可手写 SigV4 签名实现
- 需注意删除 bucket 前的空桶校验
- 支持跨实例批量创建/删除
- 可加入 `FEATURE_PROPOSALS.md` 作为独立提议

### 已有提议中的未实施项

以下提议已在 `FEATURE_PROPOSALS.md` 中记录但尚未实施，按优先级排序：

| 提议 | 名称 | 优先级 |
|---|---|---|
| 2 | 分发历史记录与持久化 | 中 |
| 5 | 用户认证与访问控制 | 中 |
| 6 | 密钥加密存储 | 中 |
| 7 | 分发预设/模板 | 低 |
| 8 | 操作审计日志 | 低 |
| 9 | 增量分发（跳过未变更文件） | 低 |
| 10 | 定时/计划分发任务 | 低 |
| 12 | 暂存磁盘管理面板 | 低 |
