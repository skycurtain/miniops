# 时钟偏差导致连通性测试 403：排查记录与解决方案

> 2026-07-16 排查记录。V1 重构时评估是否引入 AWS SDK 的参考依据之一。

## 1. 问题现象

在测试环境（21 号线杨浦实验环境）添加真实 MinIO 实例（`http://10.24.0.10:9000`，OCC），凭据（accessKey/secretKey）经确认正确，但连通性测试反馈 **凭据无效 (403 Access Denied)**。

此前在本机 Docker MinIO 上一切正常；切换 Bun 运行时后也正常。**与运行时（Bun/Node）无关**，是第一次连接真实 MinIO 时暴露的问题。

## 2. 根因

**MinIO 服务器与本机存在约 8 小时的时钟偏差。**

SigV4 签名要求客户端请求时间（`x-amz-date` 头）与服务器时间差不超过 **15 分钟**。当前偏差约 8 小时（MinIO 服务器时钟超前），远超限制，MinIO 返回 403。

### 验证数据

| 项目                              | 值                                                       |
| --------------------------------- | -------------------------------------------------------- |
| 本机 UTC 时间                     | `2026-07-16T05:06:00Z`                                   |
| MinIO 服务器时间（`Date` 响应头） | `Thu, 16 Jul 2026 13:06:53 GMT`                          |
| 偏差                              | **约 28860 秒（8.0 小时）**                              |
| MinIO 返回的错误码                | **`RequestTimeTooSkewed`**（非 `SignatureDoesNotMatch`） |

关键证据：MinIO 明确返回 `RequestTimeTooSkewed - The difference between the request time and the server's time is too large.`，直接指出时间差过大。

### 验证过程

用三组对照测试确认了根因：

| 测试                       | 方式                             | 结果                          | 说明                      |
| -------------------------- | -------------------------------- | ----------------------------- | ------------------------- |
| **AWS SDK ListBuckets**    | `@aws-sdk/client-s3`             | ✅ 200，列出 4 个 bucket      | SDK 内部自动校正时钟偏差  |
| **手写签名（客户端时间）** | 当前项目的 `signRequest`         | ❌ 403 `RequestTimeTooSkewed` | 签名时间与服务器差 8 小时 |
| **手写签名（校正后时间）** | 用服务器 `Date` 头校正偏移后签名 | ✅ 200，列出 4 个 bucket      | 校正时间后签名通过        |

校正方案的验证脚本（已删除）：

1. 先请求 `/minio/health/live`，从响应 `Date` 头读取服务器时间
2. 计算 `offset = serverTime - clientTime`（约 +28860 秒）
3. 签名时用 `new Date(Date.now() + offset)` 生成 `x-amz-date`
4. 结果：403 → 200

## 3. 与运行时（Bun/Node）无关

已排除以下因素：

- **签名算法**：`server/utils/minio.ts` 的 SigV4 代码逻辑正确，Bun 下 `node:crypto` 的 `createHmac`/`createHash` 验证通过
- **环境变量代理**：无 `HTTP_PROXY`/`HTTPS_PROXY`（大小写均无）
- **Bun fetch 行为**：Host 头正确传递，自动添加的额外 headers 不在签名范围内
- **网络代理**（Clash `127.0.0.1:7897`）：Bun 的 fetch 不读 Windows 系统代理；curl 直连 health/live 返回 200，代理未拦截内网流量

本机 Docker MinIO 正常是因为 Docker 容器与宿主机共享时钟；真实 MinIO 服务器时钟不准才暴露问题。

## 4. 解决方案选项

### 选项 A：手写时钟校正（不引入 SDK）

**思路**：在签名前先探一次服务器时间，计算偏移，签名时用校正后的时间。

**实现要点**：

- 请求 `/minio/health/live` 或任意请求，从 `Date` 响应头读服务器时间
- `offset = serverTime - clientTime`，缓存 offset（带 TTL，比如 5 分钟）
- `signRequest` / `presignUrl` 的时间生成改为 `new Date(Date.now() + offset)`
- 首次请求可能仍失败（offset 未建立），需重试机制

**优点**：

- 保持"零 SDK 依赖"原则
- 改动集中在 `server/utils/minio.ts` 的签名逻辑

**缺点**：

- 增加复杂度（时间探测、缓存、重试）
- 仍是手写 SigV4，已有隐患（如 `&#39;` XML 解析 bug，见待办第 3 项 XML 重构）
- 非标准做法，未来可能遇到更多 S3 兼容性问题

### 选项 B：引入 AWS SDK（打破零 SDK 原则）

**思路**：用 `@aws-sdk/client-s3` 替换手写 SigV4 签名。

**优点**：

- SDK 自动处理时钟偏差、签名重试、region 差异等
- 代码量大幅减少，可靠性提升
- 不再需要手写 SigV4、Multipart Upload 等
- 解决同类问题（签名边界情况、S3 兼容性）

**缺点**：

- 打破 AGENTS.md 中"零 SDK 依赖"原则
- 引入 `@aws-sdk/client-s3`（包体积较大，~1.5MB）
- V1 重构工作量较大（替换 `server/utils/minio.ts` 全部实现）

### 选项 C：修服务器时钟

**思路**：让测试环境运维同步 NTP，校准 MinIO 服务器时钟。

**优点**：根本解决方案，代码不用改

**缺点**：

- 不受我们控制（依赖运维）
- 治标不治本：部署到其他环境可能再遇到同样问题
- 生产环境的 MinIO 时钟可能也不准

## 5. 留给 V1 评估的决策点

V1 重构时需决定：

1. **是否引入 `@aws-sdk/client-s3`？** 如果引入，手写 SigV4 全部废弃，时钟偏差问题自动解决。
2. **如果不引入 SDK**，是否实现选项 A（手写时钟校正）？这会成为 `server/utils/minio.ts` 的一个必要补丁。
3. **AGENTS.md 中"零 SDK 依赖"原则的初衷是什么？** 如果只是为了"轻量"，V1 可以重新评估。AWS SDK 是成熟的开源工具（Apache 2.0），引入它比手写 SigV4 更可靠。
4. **Bun 内置 S3Client 是否可用？** 当前测试发现 Bun 的 `S3Client` 没有 `listBuckets` 方法，且 `write` 操作触发 panic（Bun 自身 bug）。作为 V1 候选方案有待观察 Bun 后续版本。

## 6. 附：测试时的关键命令

```bash
# 查看 MinIO 服务器时间（从 Date 响应头）
curl -v http://10.24.0.10:9000/minio/health/live 2>&1 | grep "< Date"

# 对比本机 UTC 时间
date -u

# 偏差超过 15 分钟即为问题
```
