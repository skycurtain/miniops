<script setup lang="ts">
/**
 * 进度卡片（staging/dispatching/done/cancelled 阶段显示）。
 *
 * 包含：
 * - 暂存阶段进度（扁平文件列表 + 上传百分比）
 * - 分发阶段进度（实例维度聚合折叠视图）
 * - 完成/取消状态显示
 * - 失败重试按钮
 *
 * 通过 inject 获取分发 composable 的共享状态。
 */
import { useInjectDispatch } from '~/composables/use-dispatch'

const dispatch = useInjectDispatch()
const {
  phase,
  taskSummary,
  progressMatrix,
  progressExpanded,
  progressInstanceList,
  files,
  phaseLabel,
  stagingOverall,
  getOverallProgress,
  getInstanceProgress,
  retryInstance,
  formatSize,
  fileIcon,
} = dispatch
</script>

<template>
  <div class="border-default bg-default flex shrink-0 flex-col rounded-lg border">
    <!-- 卡片头 -->
    <div class="flex min-h-12 items-center justify-between border-default border-b px-4 py-2.5">
      <div class="flex items-center gap-2">
        <NuxtIcon
          v-if="phase === 'staging' || phase === 'dispatching'"
          name="i-lucide-loader-circle"
          class="text-primary size-4 animate-spin"
        />
        <NuxtIcon
          v-else-if="phase === 'done' && taskSummary?.failed"
          name="i-lucide-triangle-alert"
          class="text-warning size-4"
        />
        <NuxtIcon
          v-else-if="phase === 'cancelled'"
          name="i-lucide-circle-slash"
          class="text-muted size-4"
        />
        <NuxtIcon v-else name="i-lucide-check-circle" class="text-success size-4" />
        <span class="text-highlighted text-sm font-semibold">
          {{ phase === 'staging' ? '暂存进度' : '分发进度' }}
        </span>
        <NuxtBadge color="neutral" variant="subtle" size="sm">{{ phaseLabel }}</NuxtBadge>
      </div>
      <div class="flex items-center gap-3 text-xs">
        <span v-if="phase === 'staging'" class="text-muted">
          {{ stagingOverall.done }}/{{ stagingOverall.total }}
        </span>
        <template v-else-if="taskSummary">
          <span class="text-muted">共 {{ taskSummary.total }}</span>
          <NuxtBadge color="success" variant="soft" size="sm">成功 {{ taskSummary.success }}</NuxtBadge>
          <NuxtBadge v-if="taskSummary.failed" color="error" variant="soft" size="sm">
            失败 {{ taskSummary.failed }}
          </NuxtBadge>
          <NuxtBadge v-if="taskSummary.skipped" color="neutral" variant="soft" size="sm">
            跳过 {{ taskSummary.skipped }}
          </NuxtBadge>
        </template>
      </div>
    </div>

    <!-- ═══ 暂存阶段视图：扁平文件列表 + 上传百分比 ═══ -->
    <div v-if="phase === 'staging'" class="min-h-0 flex-1 overflow-y-auto p-2">
      <div class="flex flex-col gap-1.5">
        <div
          v-for="f in files"
          :key="f.id"
          class="border-default bg-elevated flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
        >
          <NuxtIcon :name="fileIcon(f.name)" class="text-primary size-4 shrink-0" />
          <span class="truncate flex-1 font-mono">{{ f.objectKey }}</span>
          <span class="text-muted text-xs shrink-0">{{ formatSize(f.size) }}</span>
          <div class="w-24 shrink-0">
            <NuxtProgress
              :model-value="f.progress"
              size="xs"
              :class="f.status === 'error' ? 'text-error' : ''"
            />
          </div>
          <span class="text-muted text-xs shrink-0 w-12 text-right">
            <template v-if="f.status === 'done'">完成</template>
            <template v-else-if="f.status === 'error'"><span class="text-error">失败</span></template>
            <template v-else>{{ f.progress ? `${f.progress}%` : '等待中' }}</template>
          </span>
        </div>
      </div>
    </div>

    <!-- ═══ 分发阶段视图：实例维度聚合折叠 ═══ -->
    <template v-else>
      <!-- 总进度条 -->
      <div class="border-default border-b px-4 py-2.5">
        <NuxtProgress :model-value="getOverallProgress()" size="sm" />
      </div>
      <!-- 实例级折叠列表 -->
      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <div
          v-for="inst in progressInstanceList"
          :key="inst.id"
          class="border-default rounded-md border"
        >
          <div
            class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-elevated/50"
            @click="progressExpanded[inst.id] = !progressExpanded[inst.id]"
          >
            <NuxtIcon
              :name="progressExpanded[inst.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              class="text-muted size-4 shrink-0"
            />
            <NuxtIcon name="i-lucide-server" class="text-muted size-4 shrink-0" />
            <span class="text-sm font-medium">{{ inst.name }}</span>
            <span class="text-muted font-mono text-xs">{{ inst.bucket || '未指定' }}</span>
            <div class="flex-1" />
            <span class="text-muted text-sm">
              {{ getInstanceProgress(inst.id).completed }}/{{ getInstanceProgress(inst.id).total }}
            </span>
            <div class="w-20">
              <NuxtProgress
                :model-value="getInstanceProgress(inst.id).total
                  ? (getInstanceProgress(inst.id).completed / getInstanceProgress(inst.id).total * 100)
                  : 0"
                size="xs"
              />
            </div>
            <NuxtBadge
              v-if="getInstanceProgress(inst.id).failed > 0"
              color="error" variant="soft" size="sm"
            >
              {{ getInstanceProgress(inst.id).failed }} 失败
            </NuxtBadge>
            <NuxtButton
              v-if="getInstanceProgress(inst.id).failed > 0 && (phase === 'done' || phase === 'cancelled')"
              size="xs"
              color="warning"
              variant="ghost"
              icon="i-lucide-rotate-ccw"
              label="重试"
              @click.stop="retryInstance(inst.id)"
            />
          </div>
          <!-- 文件明细 -->
          <div
            v-if="progressExpanded[inst.id]"
            class="border-default border-t px-3 py-1.5"
          >
            <div
              v-for="f in files"
              :key="f.id"
              class="flex items-center gap-2 py-0.5 text-sm"
            >
              <NuxtIcon :name="fileIcon(f.name)" class="text-muted size-3.5 shrink-0" />
              <span class="truncate flex-1 font-mono text-xs">{{ f.objectKey }}</span>
              <template v-if="progressMatrix[inst.id]?.[f.objectKey]?.status === 'running'">
                <NuxtIcon name="i-lucide-loader-circle" class="text-primary size-3.5 animate-spin shrink-0" />
                <span class="text-primary text-xs">分发中</span>
              </template>
              <template v-else-if="progressMatrix[inst.id]?.[f.objectKey]?.status === 'pending'">
                <span class="text-muted text-xs">等待中</span>
              </template>
              <template v-else-if="progressMatrix[inst.id]?.[f.objectKey]?.status === 'skipped'">
                <span class="text-muted text-xs">已跳过</span>
              </template>
              <template v-else-if="progressMatrix[inst.id]?.[f.objectKey]?.status === 'success'">
                <NuxtIcon name="i-lucide-check-circle" class="text-success size-3.5 shrink-0" />
                <span class="text-muted text-xs">{{ progressMatrix[inst.id]![f.objectKey]!.duration }}ms</span>
              </template>
              <template v-else-if="progressMatrix[inst.id]?.[f.objectKey]?.status === 'failed'">
                <NuxtIcon name="i-lucide-x-circle" class="text-error size-3.5 shrink-0" />
                <span class="text-error truncate text-xs">{{ progressMatrix[inst.id]![f.objectKey]!.error || '失败' }}</span>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
