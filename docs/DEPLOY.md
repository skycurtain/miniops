# miniops 部署文档

## 一、环境要求

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | 推荐 20+；也可用 Bun |
| Bun（可选） | ≥ 1.0 | 推荐，构建和运行更快 |
| MinIO | 任意版本 | 目标实例，S3 兼容协议 |

## 二、安装依赖

```bash
# 用 Bun（推荐）
bun install

# 或用 npm
npm install
```

## 三、开发模式

```bash
bun run dev
# 或 npm run dev
```

默认端口 3000，访问 http://localhost:3000

## 四、生产构建

```bash
bun run build
# 或 npm run build
```

构建产物在 `.output/` 目录。

## 五、生产启动

```bash
# 用 Bun 运行 Nitro 产物
bun run .output/server/index.mjs

# 或用 Node.js 运行
node .output/server/index.mjs
```

默认监听 3000 端口。可通过环境变量 `PORT` 修改：

```bash
PORT=8080 bun run .output/server/index.mjs
```

建议配合进程守护工具：
- **pm2**: `pm2 start .output/server/index.mjs --name miniops`
- **systemd**: 编写 service unit

## 六、环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口 |
| `DISPATCH_CONCURRENCY` | `5` | 文件分发并发数 |
| `DATA_FILE_PATH` | `server/data/groups.json` | 实例组数据文件路径 |

## 七、数据存储

实例组配置存储在 `server/data/groups.json`（JSON 文件），首次启动自动创建内置"默认"组。

数据文件路径可通过 `DATA_FILE_PATH` 环境变量自定义，建议指向持久化目录。

## 八、Nginx 反向代理（可选）

SSE 需要关闭缓冲，否则进度推送不实时：

```nginx
server {
    listen 80;
    server_name miniops.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # SSE 端点：关闭缓冲和超时
    location /api/dispatch/events {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
    }
}
```

## 九、备份与恢复

- **备份**：复制 `server/data/groups.json` 即可
- **恢复**：将备份文件放回原路径，重启服务
- **迁移**：在新环境安装后，通过"导入"功能上传备份的 JSON

## 十、验证清单

部署后按以下步骤验证：

1. 访问首页，确认总览页正常加载
2. 进入"实例"页，创建一个实例组并添加实例
3. 测试连通性，确认在线状态
4. 进入"文件分发"页，选择文件和目标，执行分发
5. 确认进度矩阵实时更新，上传成功
6. 登录 MinIO Console，确认文件可预览（Content-Type 为 application/json）
