<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { mockGroups, type MockInstance } from './mock-data'

definePageMeta({ layout: 'default' })

const groups = ref(structuredClone(mockGroups))

const openGroups = ref<Record<string, boolean>>({
  'grp-default': false,
  'grp-1': true,
  'grp-2': false,
})

// 连通性测试状态（mock）
const testingInstances = ref<Set<string>>(new Set())

const columns: TableColumn<MockInstance>[] = [
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'endpoint', header: 'Endpoint' },
  { accessorKey: 'enabled', header: '状态', meta: { class: { th: 'w-20', td: 'w-20' } } },
  { id: 'connectivity', header: '连通性', meta: { class: { th: 'w-40', td: 'w-40' } } },
  { id: 'actions', header: '操作', meta: { class: { th: 'w-80', td: 'w-80' } } },
]

// Mock: 模拟单实例连通性测试
async function testInstance(group: (typeof groups.value)[0], instanceId: string) {
  testingInstances.value.add(instanceId)
  const inst = group.instances.find((i) => i.id === instanceId)
  if (inst) inst.connectivity = 'testing'
  await new Promise((r) => setTimeout(r, 1000))
  if (inst) {
    // mock 结果：保持原有状态
    inst.connectivity = inst.endpoint.includes('0.1')
      ? 'online'
      : inst.endpoint.includes('0.2')
        ? 'offline'
        : 'auth-error'
    if (inst.connectivity === 'online') inst.latency = Math.floor(Math.random() * 30) + 5
  }
  testingInstances.value.delete(instanceId)
}

// Mock: 切换启用/禁用
function toggleEnabled(group: (typeof groups.value)[0], instanceId: string) {
  const inst = group.instances.find((i) => i.id === instanceId)
  if (inst) inst.enabled = !inst.enabled
}
</script>

<template>
  <NuxtDashboardPanel id="manage-proto">
    <template #header>
      <AppNavbar title="实例管理（原型）" />
    </template>

    <template #body>
      <!-- 页头 -->
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="text-highlighted text-2xl font-bold">实例管理</h1>
          <p class="text-muted">管理实例组与组内 MinIO 实例</p>
        </div>
        <div class="flex items-center gap-2">
          <NuxtButton color="neutral" variant="ghost" icon="i-lucide-file-down"> 模板 </NuxtButton>
          <NuxtButton color="neutral" variant="outline" icon="i-lucide-download"> 导入 </NuxtButton>
          <NuxtButton color="neutral" variant="outline" icon="i-lucide-upload"> 导出 </NuxtButton>
          <NuxtButton color="primary" icon="i-lucide-plus"> 新建组 </NuxtButton>
        </div>
      </div>

      <!-- 分组列表 -->
      <div class="flex flex-col gap-3">
        <div
          v-for="group in groups"
          :key="group.id"
          class="border-default bg-default rounded-lg border"
        >
          <NuxtCollapsible v-model:open="openGroups[group.id]">
            <!-- 分组标题行 -->
            <div class="flex items-center gap-3 p-3">
              <NuxtButton
                :icon="openGroups[group.id] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                color="neutral"
                variant="ghost"
                size="sm"
                class="text-muted"
              />

              <NuxtIcon name="i-lucide-folder" class="text-primary size-4 shrink-0" />
              <span class="text-highlighted truncate font-semibold">{{ group.name }}</span>
              <NuxtBadge v-if="group.isDefault" color="neutral" variant="outline" size="sm">
                内置
              </NuxtBadge>
              <NuxtBadge color="neutral" variant="subtle" size="sm">
                {{ group.instances.length }} 个实例
              </NuxtBadge>

              <div class="ml-auto flex items-center gap-1">
                <NuxtButton
                  v-if="group.instances.length"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-activity"
                  label="测试全部"
                />
                <NuxtButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-plus"
                  label="添加实例"
                />
                <NuxtButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" />
                <NuxtButton
                  v-if="!group.isDefault"
                  size="xs"
                  color="error"
                  variant="ghost"
                  icon="i-lucide-trash-2"
                />
              </div>
            </div>

            <!-- 展开态：实例表格 -->
            <template #content>
              <div class="border-default border-t p-3">
                <NuxtTable
                  v-if="group.instances.length"
                  :data="group.instances"
                  :columns="columns"
                >
                  <template #name-cell="{ row }">
                    <span class="font-medium" :class="{ 'text-dimmed': !row.original.enabled }">
                      {{ row.original.name }}
                    </span>
                  </template>

                  <template #endpoint-cell="{ row }">
                    <span class="text-muted font-mono text-xs">{{ row.original.endpoint }}</span>
                  </template>

                  <template #enabled-cell="{ row }">
                    <NuxtBadge
                      :color="row.original.enabled ? 'success' : 'neutral'"
                      :variant="row.original.enabled ? 'soft' : 'outline'"
                    >
                      {{ row.original.enabled ? '启用' : '禁用' }}
                    </NuxtBadge>
                  </template>

                  <template #connectivity-cell="{ row }">
                    <!-- 测试中 -->
                    <NuxtIcon
                      v-if="row.original.connectivity === 'testing'"
                      name="i-lucide-loader-circle"
                      class="text-muted size-4 animate-spin"
                    />
                    <!-- 未测试 -->
                    <span v-else-if="!row.original.connectivity" class="text-muted text-xs">-</span>
                    <!-- 不可达 -->
                    <NuxtTooltip v-else-if="row.original.connectivity === 'offline'" text="连接超时">
                      <NuxtBadge color="error" variant="outline">不可达</NuxtBadge>
                    </NuxtTooltip>
                    <!-- 在线但凭据无效 -->
                    <NuxtTooltip
                      v-else-if="row.original.connectivity === 'auth-error'"
                      text="403 Access Denied"
                    >
                      <div class="flex items-center gap-1">
                        <NuxtBadge color="warning" variant="soft">在线</NuxtBadge>
                        <NuxtIcon
                          name="i-lucide-triangle-alert"
                          class="text-warning size-3.5 shrink-0"
                        />
                      </div>
                    </NuxtTooltip>
                    <!-- 在线且凭据有效 -->
                    <div v-else class="flex items-center gap-1">
                      <NuxtBadge color="success" variant="soft">在线</NuxtBadge>
                      <span v-if="row.original.latency" class="text-muted text-xs"
                        >{{ row.original.latency }}ms</span
                      >
                    </div>
                  </template>

                  <template #actions-cell="{ row }">
                    <div class="flex items-center gap-1">
                      <NuxtTooltip text="测试连通性">
                        <NuxtButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          icon="i-lucide-activity"
                          @click="testInstance(group, row.original.id)"
                        />
                      </NuxtTooltip>
                      <NuxtTooltip :text="row.original.enabled ? '浏览对象' : '请先启用实例'">
                        <NuxtButton
                          size="xs"
                          color="info"
                          variant="soft"
                          icon="i-lucide-folder-search"
                          :disabled="!row.original.enabled"
                        />
                      </NuxtTooltip>
                      <NuxtTooltip text="编辑">
                        <NuxtButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          icon="i-lucide-pencil"
                        />
                      </NuxtTooltip>
                      <NuxtTooltip text="复制">
                        <NuxtButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          icon="i-lucide-copy"
                        />
                      </NuxtTooltip>
                      <NuxtTooltip :text="row.original.enabled ? '禁用' : '启用'">
                        <NuxtButton
                          size="xs"
                          color="neutral"
                          variant="ghost"
                          :icon="
                            row.original.enabled ? 'i-lucide-power-off' : 'i-lucide-circle-check'
                          "
                          @click="toggleEnabled(group, row.original.id)"
                        />
                      </NuxtTooltip>
                      <NuxtTooltip text="删除">
                        <NuxtButton
                          size="xs"
                          color="error"
                          variant="ghost"
                          icon="i-lucide-trash-2"
                        />
                      </NuxtTooltip>
                    </div>
                  </template>
                </NuxtTable>

                <div v-else class="text-muted flex items-center gap-2 py-6">
                  <NuxtIcon name="i-lucide-inbox" class="size-5" />
                  <span>该组暂无实例，点击右上角"添加实例"开始添加。</span>
                </div>
              </div>
            </template>
          </NuxtCollapsible>
        </div>
      </div>
    </template>
  </NuxtDashboardPanel>
</template>
