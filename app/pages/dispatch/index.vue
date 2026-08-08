<script setup lang="ts">
/**
 * 文件分发页面（纯布局）。
 *
 * 顶层调用 provideDispatch() 初始化 composable 并 provide 给子组件。
 * 左侧保留实例树（树逻辑和目标选择耦合较紧）。
 * 右侧通过三个子组件渲染：文件列表 / 进度 / 分发配置。
 */
import { provideDispatch } from '~/composables/use-dispatch'
import type { DispatchTreeItem } from '~/composables/use-dispatch'

definePageMeta({ layout: 'default' })

const dispatch = provideDispatch()
const {
  groupsData,
  groupsPending,
  groupsError,
  refresh,
  treeItems,
  selectedInstances,
  phase,
  showProgress,
  findGroupById,
  findInstanceById,
  onInstanceNodeClick,
  toggleInstance,
  toggleGroup,
  isGroupAllSelected,
  isGroupPartialSelected,
  fileInput,
  folderInput,
  onFilesSelected,
  onFolderSelected,
} = dispatch
</script>

<template>
  <NuxtDashboardPanel id="dispatch">
    <template #header>
      <AppNavbar title="文件分发" />
    </template>

    <template #body>
      <!-- 页头行（跨全宽） -->
      <div class="flex shrink-0 items-center justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="text-highlighted text-2xl font-bold">
            文件分发
          </h1>
          <p class="text-muted">
            将本地文件/文件夹批量分发到目标 MinIO 实例
          </p>
        </div>
        <div class="flex items-center gap-2">
          <input ref="fileInput" type="file" multiple class="hidden" @change="onFilesSelected">
          <input
            ref="folderInput"
            type="file"
            webkitdirectory
            directory
            multiple
            class="hidden"
            @change="onFolderSelected"
          >
          <NuxtButton
            color="neutral"
            variant="outline"
            icon="i-lucide-file-plus"
            label="添加文件"
            :disabled="phase !== 'idle'"
            @click="fileInput?.click()"
          />
          <NuxtButton
            color="neutral"
            variant="outline"
            icon="i-lucide-folder-plus"
            label="添加文件夹"
            :disabled="phase !== 'idle'"
            @click="folderInput?.click()"
          />
        </div>
      </div>

      <div class="flex h-full min-h-0 gap-3">
        <!-- ═══ 左侧栏：目标实例树 ═══ -->
        <div class="border-default bg-default flex w-64 shrink-0 flex-col overflow-hidden rounded-lg border">
          <div class="flex shrink-0 items-center justify-between px-3 py-2">
            <span class="text-highlighted text-sm font-semibold">目标实例</span>
            <NuxtBadge color="neutral" variant="subtle" size="sm">
              已选 {{ selectedInstances.size }}
            </NuxtBadge>
          </div>

          <!-- 加载中 -->
          <div v-if="groupsPending" class="text-muted flex items-center justify-center gap-2 py-8 text-sm">
            <NuxtIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
            <span>加载实例...</span>
          </div>

          <!-- 加载失败 -->
          <div v-else-if="groupsError" class="text-error flex flex-col items-center gap-2 py-8 px-4 text-center text-sm">
            <NuxtIcon name="i-lucide-server-off" class="size-8" />
            <span>加载实例失败</span>
            <NuxtButton size="xs" color="neutral" variant="outline" label="重试" @click="refresh()" />
          </div>

          <!-- 空状态 -->
          <div v-else-if="!groupsData?.length" class="text-muted flex flex-col items-center gap-2 py-8 px-4 text-center text-sm">
            <NuxtIcon name="i-lucide-server-off" class="size-8" />
            <span>暂无实例分组</span>
          </div>

          <!-- 实例树 -->
          <div v-else class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <NuxtTree
              :items="treeItems"
              :get-key="(item: DispatchTreeItem) => item.instanceId ?? item.groupId ?? item.label!"
              :expanded-icon="'i-lucide-chevron-down'"
              :collapsed-icon="'i-lucide-chevron-right'"
              :as="{ link: 'div' }"
              color="primary"
              size="sm"
            >
              <template #item-leading="{ item }">
                <!-- 分组节点：全选 checkbox -->
                <NuxtCheckbox
                  v-if="item.groupId && !item.instanceId"
                  :model-value="isGroupAllSelected(findGroupById(item.groupId)!)"
                  :indeterminate="isGroupPartialSelected(findGroupById(item.groupId)!)"
                  :disabled="!findGroupById(item.groupId)!.instances.filter(i => i.enabled).length || phase !== 'idle'"
                  class="shrink-0"
                  @update:model-value="toggleGroup(findGroupById(item.groupId)!)"
                  @click.stop
                />
                <!-- 实例节点：单选 checkbox（disabled 实例不显示） -->
                <NuxtCheckbox
                  v-else-if="item.instanceId && findInstanceById(item.instanceId)?.enabled"
                  :model-value="selectedInstances.has(item.instanceId)"
                  :disabled="phase !== 'idle'"
                  class="shrink-0"
                  @update:model-value="toggleInstance(findInstanceById(item.instanceId)!)"
                  @click.stop
                />
              </template>

              <template #item-label="{ item }">
                <!-- 分组节点 -->
                <div v-if="item.groupId && !item.instanceId" class="flex min-w-0 flex-1 items-center gap-1.5">
                  <NuxtIcon name="i-lucide-folder" class="text-primary size-4 shrink-0" />
                  <span class="text-highlighted truncate text-sm font-medium">{{ item.label }}</span>
                  <NuxtBadge
                    v-if="findGroupById(item.groupId)?.isDefault"
                    color="neutral" variant="outline" size="sm" class="shrink-0"
                  >
                    内置
                  </NuxtBadge>
                </div>
                <!-- 实例节点 -->
                <div
                  v-else-if="item.instanceId"
                  class="flex min-w-0 flex-1 items-center gap-1.5"
                  :class="{ 'opacity-50': !findInstanceById(item.instanceId)?.enabled }"
                  :title="findInstanceById(item.instanceId)?.endpoint"
                  @click.stop="onInstanceNodeClick(item.instanceId)"
                >
                  <NuxtIcon name="i-lucide-server" class="text-muted size-4 shrink-0" />
                  <span
                    class="truncate text-sm font-medium"
                    :class="!findInstanceById(item.instanceId)?.enabled ? 'text-muted' : 'text-highlighted'"
                  >
                    {{ item.label }}
                  </span>
                  <NuxtBadge
                    v-if="!findInstanceById(item.instanceId)?.enabled"
                    color="neutral" variant="outline" size="sm" class="shrink-0"
                  >
                    禁用
                  </NuxtBadge>
                </div>
              </template>
            </NuxtTree>
          </div>
        </div>

        <!-- ═══ 右侧主操作区 ═══ -->
        <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
          <!-- 文件列表卡片（idle 时显示） -->
          <DispatchFileList v-if="!showProgress" />

          <!-- 进度卡片（staging/dispatching/done/cancelled 时替代文件列表位置显示） -->
          <DispatchProgress v-if="showProgress" />

          <!-- 分发配置卡片（idle 时常驻显示） -->
          <DispatchConfig />
        </div>
      </div>
    </template>
  </NuxtDashboardPanel>
</template>
