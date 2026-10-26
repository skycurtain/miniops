# 产品定位：从 MinIO 专用到通用 S3

- **Status: Shipped**（阶段 A/B/C 已合入 main）
- **分支记录**: `rebrand`（A/B/C 三提交）

## 背景

MinIO 开源社区版停止维护、Docker 官方镜像下架。项目若继续绑定 MinIO 品牌，既过时又限制选型。

## 决策

定位调整为 **「S3 对象存储运维平台」**。MinIO 降级为受支持后端之一。

## 依据

1. 协议层本就是标准 S3（`@aws-sdk/client-s3`）
2. 2026-10 实测：PGSTY SILO、RustFS **零改动**通过 miniops 全链路
3. 唯一偏 MinIO 的路径 `/minio/health/live` 在 SILO / RustFS 亦可用，并已做 ListBuckets 降级

## 已完成改造

| 阶段 | 内容 |
|------|------|
| A | UI/文档品牌文案 → S3 / 对象存储 |
| B | `MinioInstance` → `S3Instance`，`minio.ts` → `s3.ts` |
| C | health 可降级探测；实例 `region` 可配 |

## 挂起

- README / 对外叙事：并入文档中心与后续对外材料，不单独做阶段 D

## 影响

- `groups.json` 磁盘格式不变（类型名不进 JSON）
- 产品名 `miniops` 保留
