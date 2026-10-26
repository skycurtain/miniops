# 快速开始

把 miniops 跑起来，并完成「添加实例 → 浏览对象 → 分发一个文件」的最短路径。

## 1. 前置条件

- **Bun**（开发与生产均依赖；Windows 下 compose 命令是 `docker-compose`）
- 至少一个 **S3 兼容对象存储**（MinIO / PGSTY SILO / RustFS / 其他）

本地测试后端可参考项目外的 Docker Compose 配置（例如 `D:\docker\dockers-compose\miniops-*`）：

| 服务 | 建议端口 | 说明 |
|------|----------|------|
| MinIO / SILO | 9000/9001 | MinIO 系含 Console |
| RustFS | 9010/9011 | 亦提供 `/minio/health/live` |

## 2. 启动

```bash
bun install
bun run dev        # http://localhost:3000
```

生产：

```bash
bun run build
bun run start
```

## 3. 添加实例

1. 打开 **实例管理**（`/manage`）
2. 选择或新建**实例组**
3. **添加实例**：
   - 服务端点：如 `http://127.0.0.1:9000`
   - Access Key / Secret Key
   - Region：留空默认 `us-east-1`（AWS S3 等需按 bucket 区域填写）
4. 点 **连通性测试**：应显示在线且凭据有效

> 探测顺序：先请求 `GET /minio/health/live`（MinIO / SILO / RustFS）；该路径不可用时自动降级为 `ListBuckets`，因此纯 S3 实现也能识别。

## 4. 浏览对象

1. 在实例行点 **浏览对象**（或顶栏「实例访问」）
2. 选择 Bucket → 浏览虚拟目录
3. 可上传、下载、预览、删除、复制/移动

详见 [guides/browse-objects.md](../guides/browse-objects.md)。

## 5. 分发一个文件

1. 顶栏进入 **文件分发**（`/dispatch`）
2. 添加本地文件
3. 勾选目标实例并选择 Bucket
4. **开始分发** → 任务进入队列，可在右上角任务查看器查看进度

详见 [guides/dispatch-files.md](../guides/dispatch-files.md)。

## 6. 下一步

- 环境变量调优：[reference/environment.md](../reference/environment.md)
- 接入其他 S3 后端：[reference/s3-compatibility.md](../reference/s3-compatibility.md)
- 开发与调试：[local-dev.md](local-dev.md)
