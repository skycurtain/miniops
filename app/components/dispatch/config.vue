<script setup lang="ts">
/**
 * 分发配置卡片（idle 阶段常驻显示）。
 *
 * 包含：
 * - 已选目标实例列表（带 bucket 选择器）
 * - 公共 bucket 选择器（多实例时）
 * - 目标前缀输入框
 * - 提交栏按钮（开始分发/取消暂存/后台继续/取消分发/新建分发）
 *
 * 通过 inject 获取分发 composable 的共享状态。
 */
import { useInjectDispatch } from '~/composables/use-dispatch'

const dispatch = useInjectDispatch()
const {
  phase,
  selectedInstances,
  selectedInstancesList,
  instanceBuckets,
  bucketLoading,
  bucketError,
  commonBucketValue,
  prefix,
  files,
  canSubmit,
  canBackground,
  startDispatch,
  cancelStaging,
  backgroundContinue,
  cancelDispatch,
  resetToIdle,
  getAllCommonBuckets,
  applyBucketToAll,
  getBuckets,
  reloadBuckets,
  findGroupByInstanceId,
} = dispatch
</script>

<template>
  <div class="border-default bg-default flex min-h-0 flex-1 flex-col rounded-lg border">
    <div class="flex min-h-12 items-center justify-between border-default border-b px-4 py-2.5">
      <div class="flex items-center gap-2">
        <NuxtIcon name="i-lucide-route" class="text-primary size-4" />
        <span class="text-highlighted text-sm font-semibold">分发配置</span>
        <NuxtBadge color="neutral" variant="subtle" size="sm">
          {{ selectedInstancesList.length }} 个实例
        </NuxtBadge>
      </div>
      <!-- 公共 bucket 选择器（多个实例时显示，靠右） -->
      <div v-if="selectedInstancesList.length > 1" class="flex items-center gap-2">
        <NuxtIcon name="i-lucide-layers" class="text-muted size-3.5 shrink-0" />
        <span class="text-muted shrink-0 text-xs">公共 bucket</span>
        <NuxtSelectMenu
          :model-value="commonBucketValue"
          :items="getAllCommonBuckets().map(b => ({ label: b, value: b }))"
          value-key="value"
          placeholder="各不相同"
          class="w-40"
          size="xs"
          :disabled="phase !== 'idle'"
          @update:model-value="(val: string) => applyBucketToAll(val)"
        />
      </div>
    </div>
    <!-- 已选目标实例列表 -->
    <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto border-default border-b p-2">
      <!-- 空状态 -->
      <div v-if="!selectedInstancesList.length" class="text-muted flex items-center gap-2 py-4 justify-center text-sm">
        <NuxtIcon name="i-lucide-mouse-pointer-click" class="size-4" />
        <span>在左侧实例树中勾选目标实例</span>
      </div>
      <!-- 实例列表 -->
      <div
        v-for="inst in selectedInstancesList"
        :key="inst.id"
        class="border-default bg-elevated flex items-center gap-2 rounded-md border px-3 py-1.5"
      >
        <NuxtIcon name="i-lucide-server" class="text-muted size-4 shrink-0" />
        <span class="text-sm font-medium shrink-0" :title="inst.endpoint">{{ inst.name }}</span>
        <NuxtBadge color="neutral" variant="subtle" size="sm" class="shrink-0">
          {{ findGroupByInstanceId(inst.id)?.name ?? '' }}
        </NuxtBadge>
        <div class="flex-1" />
        <!-- bucket 选择器 -->
        <NuxtIcon
          v-if="bucketLoading.has(inst.id)"
          name="i-lucide-loader-circle"
          class="text-muted size-4 animate-spin shrink-0"
        />
        <template v-else-if="bucketError[inst.id]">
          <NuxtIcon name="i-lucide-alert-circle" class="text-error size-4 shrink-0" />
          <span class="text-error truncate text-xs">{{ bucketError[inst.id] }}</span>
          <NuxtButton
            size="xs"
            variant="ghost"
            color="neutral"
            label="重试"
            @click="reloadBuckets(inst.id)"
          />
        </template>
        <template v-else>
          <span class="text-muted shrink-0 text-xs">bucket</span>
          <NuxtSelectMenu
            :model-value="instanceBuckets[inst.id]"
            :items="getBuckets(inst.id).map(b => ({ label: b.name, value: b.name }))"
            value-key="value"
            placeholder="选择 bucket"
            class="w-40"
            size="xs"
            :disabled="phase !== 'idle'"
            @update:model-value="(val: string) => instanceBuckets[inst.id] = val"
          />
        </template>
      </div>
    </div>
    <!-- 目标前缀 + 提交栏 -->
    <div class="flex shrink-0 items-center gap-4 px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="text-muted text-sm shrink-0">目标前缀</span>
        <NuxtInput
          v-model="prefix"
          placeholder="留空 = bucket 根"
          class="w-56"
          :disabled="phase !== 'idle'"
        />
      </div>
      <div class="flex-1" />
      <span class="text-muted text-sm">
        已选 <span class="text-highlighted font-semibold">{{ selectedInstances.size }}</span> 个实例，
        <span class="text-highlighted font-semibold">{{ files.length }}</span> 个文件
      </span>
      <!-- idle: 开始分发 -->
      <NuxtButton
        v-if="phase === 'idle'"
        color="primary"
        icon="i-lucide-send"
        label="开始分发"
        :disabled="!canSubmit"
        @click="startDispatch"
      />
      <!-- staging: 只有取消，没有后台继续（暂存是前端 XHR，离开则中断） -->
      <template v-else-if="phase === 'staging'">
        <NuxtButton
          color="error"
          variant="outline"
          icon="i-lucide-x"
          label="取消暂存"
          @click="cancelStaging"
        />
      </template>
      <!-- dispatching: 后台继续 + 取消 -->
      <template v-else-if="phase === 'dispatching'">
        <NuxtButton
          v-if="canBackground"
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-left-right"
          label="后台继续"
          @click="backgroundContinue"
        />
        <NuxtButton
          color="error"
          variant="outline"
          icon="i-lucide-x"
          label="取消分发"
          @click="cancelDispatch"
        />
      </template>
      <!-- done/cancelled: 重置 -->
      <NuxtButton
        v-else
        color="neutral"
        variant="outline"
        icon="i-lucide-rotate-ccw"
        label="新建分发"
        @click="resetToIdle"
      />
    </div>
  </div>
</template>
