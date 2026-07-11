<script setup lang="ts">
interface MinioInstance {
  id: string
  groupId: string
  name: string
  endpoint: string
  accessKey: string
  secretKey: string
  enabled: boolean
}
interface InstanceGroup {
  id: string
  name: string
  description?: string
  instances: MinioInstance[]
  isDefault?: boolean
  createdAt: string
  updatedAt: string
}

const { data: groups, pending } = await useFetch<InstanceGroup[]>('/api/groups', {
  default: () => [],
})

// 统计
const stats = computed(() => {
  const all = groups.value ?? []
  const instances = all.flatMap(g => g.instances)
  const enabled = instances.filter(i => i.enabled)
  const disabled = instances.filter(i => !i.enabled)
  return {
    groupCount: all.length,
    instanceCount: instances.length,
    enabledCount: enabled.length,
    disabledCount: disabled.length,
  }
})

// 最近分发结果（从 sessionStorage 读取，分发页完成后写入）
const lastDispatch = ref<{ total: number; success: number; failed: number; time: string } | null>(null)
onMounted(() => {
  const raw = sessionStorage.getItem('last-dispatch')
  if (raw) {
    try { lastDispatch.value = JSON.parse(raw) } catch {}
  }
})
</script>

<template>
  <div class="flex flex-col gap-6">
    <!-- 页头 -->
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-bold text-highlighted">总览</h1>
      <p class="text-muted">MinIO 批量运维平台</p>
    </div>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <!-- 实例组数 -->
      <div class="rounded-lg border border-default bg-default p-4">
        <div class="flex items-center gap-2 text-muted">
          <NuxtIcon name="i-lucide-folder" class="size-4" />
          <span class="text-sm">实例组</span>
        </div>
        <div class="mt-2 text-3xl font-bold text-highlighted">
          <span v-if="pending" class="inline-block size-6 animate-pulse rounded bg-elevated" />
          <span v-else>{{ stats.groupCount }}</span>
        </div>
      </div>

      <!-- 实例总数 -->
      <div class="rounded-lg border border-default bg-default p-4">
        <div class="flex items-center gap-2 text-muted">
          <NuxtIcon name="i-lucide-server" class="size-4" />
          <span class="text-sm">实例总数</span>
        </div>
        <div class="mt-2 text-3xl font-bold text-highlighted">
          <span v-if="pending" class="inline-block size-6 animate-pulse rounded bg-elevated" />
          <span v-else>{{ stats.instanceCount }}</span>
        </div>
      </div>

      <!-- 启用 -->
      <div class="rounded-lg border border-default bg-default p-4">
        <div class="flex items-center gap-2 text-muted">
          <NuxtIcon name="i-lucide-circle-check" class="size-4" />
          <span class="text-sm">启用</span>
        </div>
        <div class="mt-2 text-3xl font-bold text-success">
          <span v-if="pending" class="inline-block size-6 animate-pulse rounded bg-elevated" />
          <span v-else>{{ stats.enabledCount }}</span>
        </div>
      </div>

      <!-- 禁用 -->
      <div class="rounded-lg border border-default bg-default p-4">
        <div class="flex items-center gap-2 text-muted">
          <NuxtIcon name="i-lucide-circle-off" class="size-4" />
          <span class="text-sm">禁用</span>
        </div>
        <div class="mt-2 text-3xl font-bold text-muted">
          <span v-if="pending" class="inline-block size-6 animate-pulse rounded bg-elevated" />
          <span v-else>{{ stats.disabledCount }}</span>
        </div>
      </div>
    </div>

    <!-- 快速入口 + 最近分发 -->
    <div class="grid gap-4 lg:grid-cols-2">
      <!-- 快速入口 -->
      <div class="rounded-lg border border-default bg-default p-4">
        <h2 class="mb-3 font-semibold text-highlighted">快速入口</h2>
        <div class="flex flex-col gap-2">
          <NuxtButton
            to="/ops/dispatch"
            color="primary"
            icon="i-lucide-send"
            size="lg"
            block
            trailing
          >
            文件分发
          </NuxtButton>
          <NuxtButton
            to="/groups"
            color="neutral"
            variant="outline"
            icon="i-lucide-server"
            size="lg"
            block
            trailing
          >
            实例管理
          </NuxtButton>
        </div>
      </div>

      <!-- 最近分发结果 -->
      <div class="rounded-lg border border-default bg-default p-4">
        <h2 class="mb-3 font-semibold text-highlighted">最近分发</h2>
        <template v-if="lastDispatch">
          <div class="flex items-center gap-4">
            <div class="flex flex-col items-center">
              <span class="text-2xl font-bold text-highlighted">{{ lastDispatch.total }}</span>
              <span class="text-xs text-muted">总数</span>
            </div>
            <div class="flex flex-col items-center">
              <span class="text-2xl font-bold text-success">{{ lastDispatch.success }}</span>
              <span class="text-xs text-muted">成功</span>
            </div>
            <div class="flex flex-col items-center">
              <span class="text-2xl font-bold text-error">{{ lastDispatch.failed }}</span>
              <span class="text-xs text-muted">失败</span>
            </div>
            <div class="flex-1" />
            <span class="text-xs text-muted">{{ lastDispatch.time }}</span>
          </div>
          <NuxtButton
            to="/ops/dispatch"
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-send"
            label="再次分发"
            class="mt-3"
          />
        </template>
        <div v-else class="flex items-center gap-2 py-4 text-muted">
          <NuxtIcon name="i-lucide-inbox" class="size-5" />
          <span>暂无分发记录，去 <NuxtLink to="/ops/dispatch" class="text-primary underline">文件分发</NuxtLink> 试试。</span>
        </div>
      </div>
    </div>

    <!-- 组概览列表 -->
    <div class="rounded-lg border border-default bg-default p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-semibold text-highlighted">实例组概览</h2>
        <NuxtButton to="/groups" color="neutral" variant="ghost" size="sm" icon="i-lucide-arrow-right" trailing>
          管理全部
        </NuxtButton>
      </div>
      <div v-if="pending" class="flex items-center gap-2 py-4 text-muted">
        <NuxtIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
        <span>加载中…</span>
      </div>
      <div v-else-if="!groups?.length" class="py-4 text-muted">暂无实例组</div>
      <div v-else class="flex flex-col gap-2">
        <div
          v-for="g in groups"
          :key="g.id"
          class="flex items-center gap-3 rounded-md border border-default p-2"
        >
          <NuxtIcon name="i-lucide-folder" class="size-4 shrink-0 text-primary" />
          <span class="font-medium">{{ g.name }}</span>
          <NuxtBadge v-if="g.isDefault" color="neutral" variant="outline" size="sm">内置</NuxtBadge>
          <div class="flex-1" />
          <NuxtBadge color="neutral" variant="subtle" size="sm">
            {{ g.instances.length }} 个实例
          </NuxtBadge>
          <NuxtBadge color="neutral" variant="outline" size="sm">
            {{ g.instances.filter(i => i.enabled).length }} 启用
          </NuxtBadge>
        </div>
      </div>
    </div>
  </div>
</template>
