# 统一任务架构

- **Status: Shipped**
- **实施**: 五步重构已完成（通用框架 → 分发 → copy/move → 上传 → browse 组件拆分）
- **归档参考**: `docs/archive/process/技术03-统一任务架构.md` 等

## 问题

upload / copy / move / dispatch 曾是「前端驱动」（绑 SSE 连接，关页面即中断），进度模型也不统一。

## 决策

建立后端统一任务框架，四类操作共用：

1. **任务与连接解绑**：执行在 TaskManager，SSE 仅推送；断线不中断、重连可恢复
2. **全局 FIFO 队列**：同一时刻一个执行中任务；暂存阶段不排队
3. **统一任务查看器**：navbar 常驻，覆盖全部任务类型
4. **冲突策略**：跨类型冲突不检测（同 OS：失败时报错，不为逻辑冲突加锁）

## 结构

```text
后端
  TaskManager          内存任务表 + FIFO + 订阅
  executors/           dispatch | upload | copy | move
  staging.ts           磁盘暂存（upload/dispatch 前置）
  s3.ts                S3 操作（协议层）
  SSE                  createSSEStream

前端
  useTaskManager()     useState 单例，subscribe/cancel
  TaskViewerButton     三段式：执行中 / 排队中 / 最近完成
  StagingManagerButton 暂存查看/删除
```

## 任务生命周期

```text
createTask → queued → running → done | cancelled | failed
                │
                └─ 内存保留 TASK_RETENTION_SECONDS 后清理
```

- 取消：排队中直接移除；执行中设 `cancelRequested`，执行器在**每文件开始前**检查
- 未开始文件标 `skipped`；已开始的单次 PUT 跑完
- 摘要：`total / success / failed / skipped`；单文件失败不把任务标 failed（`done` + `summary.failed>0` 表示部分失败）

## 上传策略（已决策）

- `readFile` Buffer + `PutObject` 单次 PUT
- **不引入 S3 Multipart**；大文件需求出现后再统一升级 dispatch + upload

## 启用的环境变量

见 [reference/environment.md](../reference/environment.md)。
