<script setup lang="ts">
// 文件分发页（核心页）- Phase 3 实现
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-bold text-highlighted">文件分发</h1>
      <p class="text-muted">将 JSON 配置文件批量分发到目标 MinIO 实例</p>
    </div>

    <NuxtPageCard
      icon="i-lucide-send"
      title="页面建设中"
      description="文件分发页将在 Phase 3 实现：选择文件、选择目标实例组/实例、bucket 选择器、批量上传、SSE 实时进度矩阵、失败重试。"
    />
  </div>
</template>
