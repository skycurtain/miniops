<script setup lang="ts">
// 总览页 - Phase 4 实现
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-bold text-highlighted">总览</h1>
      <p class="text-muted">miniops 控制中心 · MinIO 批量运维平台</p>
    </div>

    <NuxtPageCard
      icon="i-lucide-info"
      title="页面建设中"
      description="总览页将在 Phase 4 实现：实例组数量、实例总数、在线/离线统计、快速入口、最近分发结果。"
    >
      <template #footer>
        <div class="flex gap-2">
          <NuxtButton to="/groups" color="primary" icon="i-lucide-server" trailing>
            去管理实例
          </NuxtButton>
          <NuxtButton to="/ops/dispatch" color="neutral" variant="outline" icon="i-lucide-send" trailing>
            去文件分发
          </NuxtButton>
        </div>
      </template>
    </NuxtPageCard>
  </div>
</template>
