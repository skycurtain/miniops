# HTTP API（权威）

本文件是 HTTP 接口的唯一来源。所有 S3 操作由服务端代理，**密钥不进浏览器**。

约定：

- 请求/响应均为 JSON（下载、SSE、暂存上传除外）
- 错误：`createError({ statusCode, message })`
- 任务类操作返回 `{ taskId }`，进度用 SSE 或 `GET /api/tasks/:taskId/state`

---

## 实例管理 `/api/manage/groups`

### GET `/api/manage/groups`

列出全部分组（树：组 + 嵌套实例）。保证默认分组存在且置顶。

### POST `/api/manage/groups`

新建分组。Body：`{ name, description? }`。

### PUT `/api/manage/groups/:id`

更新分组。Body：`{ name?, description? }`。

### DELETE `/api/manage/groups/:id`

删除分组及其下实例。内置默认分组不可删。

### GET `/api/manage/groups/export`

全量导出，响应为 JSON 附件。

### GET `/api/manage/groups/template`

导入模板（静态示例 JSON）。

### POST `/api/manage/groups/import`

导入配置。按 `id` 匹配：有则更新、无则新增。逐实例校验，任一非法整批拒绝。返回 `{ added, updated }`。

### POST `/api/manage/groups/:id/instances`

新增实例。Body（`createInstanceSchema`）：

```json
{
  "name": "string",
  "endpoint": "http(s)://...",
  "accessKey": "string",
  "secretKey": "string",
  "enabled": true,
  "region": "us-east-1"
}
```

`region` 可选。

### PUT `/api/manage/groups/:id/instances/:instanceId`

更新实例（仅显式传入字段）。

### DELETE `/api/manage/groups/:id/instances/:instanceId`

删除实例。

### POST `/api/manage/groups/:id/instances/:instanceId/duplicate`

同组复制实例（新 id，名称追加「(副本)」）。

### POST `/api/manage/groups/:id/test`

整组连通性测试。Body：`{ instanceId? }`；不传则测全组 enabled 实例。

响应项（`ConnectivityResult`）：

| 字段 | 说明 |
|------|------|
| `online` | 端点是否可达 |
| `latency?` | 毫秒 |
| `authValid?` | `true` 凭据有效 / `false` 403 / `undefined` 无法判断 |
| `authError?` | 错误信息 |
| `error?` | 离线原因 |

---

## 对象浏览 `/api/browse`

### GET `/api/browse/buckets?instanceId=`

列出 bucket（含创建时间）。

### POST `/api/browse/objects/list`

```json
{ "instanceId": "string", "bucket": "string", "prefix": "string?", "continuationToken": "string?" }
```

ListObjectsV2，`delimiter=/` 虚拟目录，单页约 200 条。返回 `{ objects, commonPrefixes, isTruncated, continuationToken }`。

### GET `/api/browse/objects/download?instanceId=&bucket=&key=`

流式下载，支持 `Range`（视频 206）。`?inline=1` 时按 inline 预览响应。

### POST `/api/browse/objects/download-batch`

批量打包 ZIP 下载。Body 含对象 keys 与文件夹 prefixes。上限 `DOWNLOAD_MAX_OBJECTS`（默认 1000）。

### POST `/api/browse/objects/delete/preview`

删除前预览（列出将删除的对象）。

### POST `/api/browse/objects/delete`

删除对象/前缀。精确 keys 走 DeleteObjects；prefixes 走递归删除。

### POST `/api/browse/objects/stage`

暂存单文件（`multipart/form-data`：`file` + `objectKey` + `originalName`）。返回 `{ fileId }`。不创建任务。

### POST `/api/browse/objects/upload`

提交上传任务。Body：

```json
{
  "instanceId": "...",
  "bucket": "...",
  "prefix": "...",
  "files": [{ "fileId": "...", "objectKey": "..." }]
}
```

返回 `{ taskId }`。

### POST `/api/browse/objects/copy`

复制（同实例服务端 CopyObject，跨实例流式直传）。返回 `{ taskId }`。

### POST `/api/browse/objects/move`

移动 = 复制 + 删源。返回 `{ taskId }`。

---

## 文件分发

### POST `/api/dispatch/stage`

与 `browse/objects/stage` 相同，暂存到同一目录。

### POST `/api/dispatch`

```json
{
  "files": [{ "fileId": "...", "objectKey": "..." }],
  "targets": [{ "instanceId": "...", "bucket": "..." }],
  "prefix": ""
}
```

返回 `{ taskId }`。最终对象 key = `prefix/objectKey`。

---

## 暂存管理

### GET `/api/staging`

列出暂存文件：`StagedFileListItem[]`。

### DELETE `/api/staging`

Body：`{ fileIds?: string[] }`。缺省 `fileIds` 则清空全部。

---

## 任务 `/api/tasks`

### GET `/api/tasks?status=done,failed,cancelled&limit=10`

任务列表（默认查最近完成）。

### GET `/api/tasks/:taskId/state`

任务状态快照（SSE 重连恢复用），含 `instanceProgress` / `fileProgress`。

### GET `/api/tasks/:taskId/events`

SSE 事件流。事件类型（`TaskEvent`）：

| event | data |
|-------|------|
| `queued` | `{ taskId, queuePosition }` |
| `start` | `{ taskId }` |
| `progress` | `{ taskId, objectKey, result, instanceId? }` |
| `phase` | `{ taskId, phase }`（move：`copying`/`deleting`） |
| `complete` | `{ taskId, summary }` |
| `cancelled` | `{ taskId, summary }` |
| `error` | `{ taskId, message }` |

### POST `/api/tasks/:taskId/cancel`

取消：排队中移出队列；执行中设取消标志（检查点停止，未开始文件标 `skipped`）。

### POST `/api/tasks/viewed`

Body：`{ taskIds: string[] }`，标记已查看（消除角标）。
