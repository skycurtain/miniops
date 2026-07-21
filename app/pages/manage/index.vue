<script setup lang="ts">
import type { TableColumn, DropdownMenuItem } from '@nuxt/ui'
import type { InstanceGroup, MinioInstance } from '#shared/schemas/groups'
import { createGroupSchema, createInstanceSchema } from '#shared/schemas/groups'

definePageMeta({ layout: 'default' })

// ==================== 数据获取 ====================
const { data: groups, refresh } = await useFetch<InstanceGroup[]>('/api/manage/groups', {
  default: () => [],
})

const toast = useToast()
const { results, testing, testingGroup, testInstance, testGroup, getStatus, getGroupSummary }
  = useConnectivity()

// ==================== 选中分组 ====================
const selectedGroupId = ref<string>('')
const selectedGroup = computed(
  () => groups.value.find((g) => g.id === selectedGroupId.value) ?? null,
)

// 首次加载后自动选中第一个分组
watch(groups, (val) => {
  if (val.length && !selectedGroupId.value) {
    selectedGroupId.value = val[0]!.id
  }
}, { immediate: true })

// ==================== 表格列定义 ====================
const columns: TableColumn<MinioInstance>[] = [
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'endpoint', header: 'Endpoint' },
  { accessorKey: 'enabled', header: '状态', meta: { class: { th: 'w-20', td: 'w-20' } } },
  { id: 'connectivity', header: '连通性', meta: { class: { th: 'w-40', td: 'w-40' } } },
  { id: 'actions', header: '操作', meta: { class: { th: 'w-80', td: 'w-80' } } },
]

// ==================== 分组表单 ====================
const groupModalOpen = ref(false)
const groupModalMode = ref<'create' | 'edit'>('create')
const groupEditingId = ref<string | null>(null)
const groupForm = reactive({ name: '', description: '' })
const groupFormRef = ref()
const groupSubmitting = ref(false)

function groupRowItems(group: InstanceGroup): DropdownMenuItem[][] {
  const items: DropdownMenuItem[][] = [
    [
      {
        label: '编辑分组',
        icon: 'i-lucide-pencil',
        onSelect: () => openGroupEdit(group),
      },
    ],
  ]
  if (!group.isDefault) {
    items.push([
      {
        label: '删除分组',
        icon: 'i-lucide-trash-2',
        color: 'error',
        onSelect: () => onDeleteGroup(group),
      },
    ])
  }
  return items
}

function openGroupCreate() {
  groupModalMode.value = 'create'
  groupEditingId.value = null
  groupForm.name = ''
  groupForm.description = ''
  groupModalOpen.value = true
}

function openGroupEdit(group: InstanceGroup) {
  groupModalMode.value = 'edit'
  groupEditingId.value = group.id
  groupForm.name = group.name
  groupForm.description = group.description ?? ''
  groupModalOpen.value = true
}

async function onGroupSubmit() {
  groupSubmitting.value = true
  try {
    if (groupModalMode.value === 'create') {
      await $fetch('/api/manage/groups', {
        method: 'POST',
        body: { name: groupForm.name, description: groupForm.description || undefined },
      })
      toast.add({ title: '创建成功', description: `分组「${groupForm.name}」已创建`, color: 'success' })
    }
    else {
      await $fetch(`/api/manage/groups/${groupEditingId.value}`, {
        method: 'PUT',
        body: { name: groupForm.name, description: groupForm.description || undefined },
      })
      toast.add({ title: '修改成功', description: `分组「${groupForm.name}」已更新`, color: 'success' })
    }
    groupModalOpen.value = false
    await refresh()
  }
  catch {
    toast.add({ title: '操作失败', color: 'error' })
  }
  finally {
    groupSubmitting.value = false
  }
}

// ==================== 实例表单 ====================
const instanceModalOpen = ref(false)
const instanceModalMode = ref<'create' | 'edit'>('create')
const instanceEditingGroupId = ref<string | null>(null)
const instanceEditingId = ref<string | null>(null)
const instanceForm = reactive({
  name: '',
  endpoint: '',
  accessKey: '',
  secretKey: '',
  enabled: true,
})
const instanceFormRef = ref()
const instanceSubmitting = ref(false)
const showSecretKey = ref(false)

watch(instanceModalOpen, (open) => {
  if (!open) showSecretKey.value = false
})

function openInstanceCreate(groupId: string) {
  instanceModalMode.value = 'create'
  instanceEditingGroupId.value = groupId
  instanceEditingId.value = null
  instanceForm.name = ''
  instanceForm.endpoint = ''
  instanceForm.accessKey = ''
  instanceForm.secretKey = ''
  instanceForm.enabled = true
  instanceModalOpen.value = true
}

function openInstanceEdit(groupId: string, instance: MinioInstance) {
  instanceModalMode.value = 'edit'
  instanceEditingGroupId.value = groupId
  instanceEditingId.value = instance.id
  instanceForm.name = instance.name
  instanceForm.endpoint = instance.endpoint
  instanceForm.accessKey = instance.accessKey
  instanceForm.secretKey = instance.secretKey
  instanceForm.enabled = instance.enabled
  instanceModalOpen.value = true
}

async function onInstanceSubmit() {
  instanceSubmitting.value = true
  try {
    const groupId = instanceEditingGroupId.value!
    if (instanceModalMode.value === 'create') {
      await $fetch(`/api/manage/groups/${groupId}/instances`, {
        method: 'POST',
        body: {
          name: instanceForm.name,
          endpoint: instanceForm.endpoint,
          accessKey: instanceForm.accessKey,
          secretKey: instanceForm.secretKey,
          enabled: instanceForm.enabled,
        },
      })
      toast.add({ title: '创建成功', description: `实例「${instanceForm.name}」已添加`, color: 'success' })
    }
    else {
      await $fetch(`/api/manage/groups/${groupId}/instances/${instanceEditingId.value}`, {
        method: 'PUT',
        body: {
          name: instanceForm.name,
          endpoint: instanceForm.endpoint,
          accessKey: instanceForm.accessKey,
          secretKey: instanceForm.secretKey,
          enabled: instanceForm.enabled,
        },
      })
      toast.add({ title: '修改成功', description: `实例「${instanceForm.name}」已更新`, color: 'success' })
    }
    instanceModalOpen.value = false
    await refresh()
  }
  catch {
    toast.add({ title: '操作失败', color: 'error' })
  }
  finally {
    instanceSubmitting.value = false
  }
}

// ==================== 确认弹窗 ====================
const confirmOpen = ref(false)
const confirmTitle = ref('')
const confirmDescription = ref('')
const confirmLoading = ref(false)
const confirmAction = ref<() => Promise<void>>(async () => {})

function openConfirm(title: string, description: string, action: () => Promise<void>) {
  confirmTitle.value = title
  confirmDescription.value = description
  confirmAction.value = action
  confirmOpen.value = true
}

async function onConfirm() {
  confirmLoading.value = true
  try {
    await confirmAction.value()
  }
  finally {
    confirmLoading.value = false
    confirmOpen.value = false
  }
}

// ==================== 删除 ====================
function onDeleteGroup(group: InstanceGroup) {
  openConfirm(
    '删除分组',
    `确定删除分组「${group.name}」？该分组下的 ${group.instances.length} 个实例将一并删除。`,
    async () => {
      const idx = groups.value.findIndex((g) => g.id === group.id)
      await $fetch(`/api/manage/groups/${group.id}`, { method: 'DELETE' })
      await refresh()
      // refresh 后 groups.value 已更新（删除的分组不在了），从新数组中选相邻分组
      if (selectedGroupId.value === group.id) {
        const newIdx = Math.min(idx, groups.value.length - 1)
        selectedGroupId.value = groups.value[newIdx]?.id ?? ''
      }
      toast.add({ title: '删除成功', description: `分组「${group.name}」已删除`, color: 'success' })
    },
  )
}

function onDeleteInstance(group: InstanceGroup, instance: MinioInstance) {
  openConfirm('删除实例', `确定删除实例「${instance.name}」？`, async () => {
    await $fetch(`/api/manage/groups/${group.id}/instances/${instance.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: '删除成功', description: `实例「${instance.name}」已删除`, color: 'success' })
  })
}

// ==================== 复制实例 ====================
async function onDuplicateInstance(group: InstanceGroup, instance: MinioInstance) {
  try {
    await $fetch(`/api/manage/groups/${group.id}/instances/${instance.id}/duplicate`, { method: 'POST' })
    await refresh()
    toast.add({ title: '复制成功', description: `实例「${instance.name}」已复制`, color: 'success' })
  }
  catch {
    toast.add({ title: '复制失败', color: 'error' })
  }
}

// ==================== 启用/禁用 ====================
async function onToggleEnabled(group: InstanceGroup, instance: MinioInstance) {
  try {
    await $fetch(`/api/manage/groups/${group.id}/instances/${instance.id}`, {
      method: 'PUT',
      body: { enabled: !instance.enabled },
    })
    await refresh()
    toast.add({
      title: instance.enabled ? '已禁用' : '已启用',
      description: `实例「${instance.name}」${instance.enabled ? '已禁用' : '已启用'}`,
      color: 'success',
    })
  }
  catch {
    toast.add({ title: '操作失败', color: 'error' })
  }
}

// ==================== 导入/导出/模板 ====================
async function exportConfig() {
  try {
    const blob = await $fetch<Blob>('/api/manage/groups/export', { responseType: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'miniops-groups-export.json'
    a.click()
    URL.revokeObjectURL(url)
    toast.add({ title: '导出成功', description: '配置已下载', color: 'success' })
  }
  catch {
    toast.add({ title: '导出失败', color: 'error' })
  }
}

async function downloadTemplate() {
  try {
    const blob = await $fetch<Blob>('/api/manage/groups/template', { responseType: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'miniops-groups-template.json'
    a.click()
    URL.revokeObjectURL(url)
    toast.add({ title: '模板已下载', color: 'success' })
  }
  catch {
    toast.add({ title: '下载失败', color: 'error' })
  }
}

const importInput = ref<HTMLInputElement>()
const importLoading = ref(false)

function triggerImport() {
  importInput.value?.click()
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  importLoading.value = true
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    const result = await $fetch<{ added: number, updated: number }>('/api/manage/groups/import', {
      method: 'POST',
      body: data,
    })
    toast.add({
      title: '导入成功',
      description: `新增 ${result.added} 个分组，更新 ${result.updated} 个分组`,
      color: 'success',
    })
    await refresh()
  }
  catch (e: unknown) {
    const err = e as { statusMessage?: string, message?: string }
    toast.add({
      title: '导入失败',
      description: err.statusMessage || err.message || '文件格式错误',
      color: 'error',
    })
  }
  finally {
    importLoading.value = false
    input.value = ''
  }
}

// ==================== 连通性测试 ====================
async function testOne(groupId: string, instance: MinioInstance) {
  await testInstance(groupId, instance.id)
}

async function testAll(group: InstanceGroup) {
  await testGroup(group.id, group.instances)
}

function summaryLabel(s?: { label: string }): string {
  return s?.label ?? ''
}
</script>

<template>
  <NuxtDashboardPanel id="manage">
    <template #header>
      <AppNavbar title="实例管理" />
    </template>

    <template #body>
      <!-- 页头 -->
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="text-highlighted text-2xl font-bold">
            实例管理
          </h1>
          <p class="text-muted">
            管理实例组与组内 MinIO 实例
          </p>
        </div>
        <div class="flex items-center gap-2">
          <NuxtButton color="neutral" variant="ghost" icon="i-lucide-file-down" @click="downloadTemplate">
            模板
          </NuxtButton>
          <NuxtButton
            color="neutral"
            variant="outline"
            icon="i-lucide-download"
            :loading="importLoading"
            @click="triggerImport"
          >
            导入
          </NuxtButton>
          <NuxtButton color="neutral" variant="outline" icon="i-lucide-upload" @click="exportConfig">
            导出
          </NuxtButton>
          <NuxtButton color="primary" icon="i-lucide-plus" @click="openGroupCreate">
            新建组
          </NuxtButton>
        </div>
      </div>

      <!-- 两栏布局 -->
      <div class="flex min-h-0 flex-1 gap-3">
        <!-- 左侧：分组列表 -->
        <div
          class="border-default bg-default flex w-64 shrink-0 flex-col overflow-y-auto rounded-lg border"
        >
          <div class="flex flex-col gap-0.5 p-2">
            <div
              v-for="group in groups"
              :key="group.id"
              class="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5"
              :class="selectedGroupId === group.id ? 'bg-elevated' : 'hover:bg-elevated/50'"
              @click="selectedGroupId = group.id"
            >
              <NuxtIcon name="i-lucide-folder" class="text-primary size-4 shrink-0" />
              <NuxtTooltip :text="group.name" :content="{ side: 'top' }" :delay-duration="300">
                <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ group.name }}</span>
              </NuxtTooltip>
              <NuxtBadge
                v-if="group.isDefault"
                color="neutral"
                variant="outline"
                size="sm"
                class="shrink-0"
              >
                内置
              </NuxtBadge>
              <NuxtBadge
                color="neutral"
                variant="subtle"
                size="sm"
                class="ml-auto shrink-0"
              >
                {{ group.instances.length }}
              </NuxtBadge>
              <NuxtDropdownMenu
                :items="groupRowItems(group)"
                :content="{ align: 'end', sideOffset: 4 }"
              >
                <NuxtButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-more-vertical"
                  class="shrink-0"
                  @click.stop
                />
              </NuxtDropdownMenu>
            </div>
          </div>
        </div>

        <!-- 右侧：选中分组详情 -->
        <div
          v-if="selectedGroup"
          class="border-default bg-default flex min-h-0 flex-1 flex-col rounded-lg border"
        >
          <!-- 分组标题行 -->
          <div class="flex shrink-0 items-center gap-3 p-3">
            <NuxtIcon name="i-lucide-folder" class="text-primary size-5 shrink-0" />
            <span class="text-highlighted font-semibold">{{ selectedGroup.name }}</span>
            <NuxtBadge v-if="selectedGroup.isDefault" color="neutral" variant="outline" size="sm">
              内置
            </NuxtBadge>
            <NuxtBadge color="neutral" variant="subtle" size="sm">
              {{ selectedGroup.instances.length }} 个实例
            </NuxtBadge>
            <NuxtBadge
              v-if="getGroupSummary(selectedGroup)"
              color="neutral"
              variant="subtle"
              size="sm"
            >
              {{ summaryLabel(getGroupSummary(selectedGroup)!) }}
            </NuxtBadge>

            <div class="ml-auto flex items-center gap-1">
              <NuxtButton
                v-if="selectedGroup.instances.length"
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-activity"
                :label="testingGroup[selectedGroup.id] ? '测试中...' : '测试全部'"
                :loading="testingGroup[selectedGroup.id]"
                @click="selectedGroup && testAll(selectedGroup)"
              />
              <NuxtButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-plus"
                label="添加实例"
                @click="openInstanceCreate(selectedGroup.id)"
              />
              <NuxtButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-pencil"
                @click="openGroupEdit(selectedGroup)"
              />
              <NuxtButton
                v-if="!selectedGroup.isDefault"
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                @click="onDeleteGroup(selectedGroup)"
              />
            </div>
          </div>

          <!-- 实例表格 -->
          <div class="border-default flex-1 overflow-hidden border-t p-3">
            <NuxtTable
              v-if="selectedGroup.instances.length"
              :data="selectedGroup.instances"
              :columns="columns"
              sticky="header"
              class="h-full"
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
                <NuxtIcon
                  v-if="getStatus(row.original.id) === 'testing'"
                  name="i-lucide-loader-circle"
                  class="text-muted size-4 animate-spin"
                />
                <span v-else-if="getStatus(row.original.id) === null" class="text-muted text-xs">-</span>
                <NuxtTooltip v-else-if="getStatus(row.original.id) === 'offline'" text="连接超时">
                  <NuxtBadge color="error" variant="outline">
                    不可达
                  </NuxtBadge>
                </NuxtTooltip>
                <NuxtTooltip v-else-if="getStatus(row.original.id) === 'auth-error'" text="403 Access Denied">
                  <div class="flex items-center gap-1">
                    <NuxtBadge color="warning" variant="soft">
                      在线
                    </NuxtBadge>
                    <NuxtIcon name="i-lucide-triangle-alert" class="text-warning size-3.5 shrink-0" />
                  </div>
                </NuxtTooltip>
                <div v-else class="flex items-center gap-1">
                  <NuxtBadge color="success" variant="soft">
                    在线
                  </NuxtBadge>
                  <span v-if="results[row.original.id]?.latency" class="text-muted text-xs">
                    {{ results[row.original.id]!.latency }}ms
                  </span>
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
                      :loading="testing[row.original.id]"
                      @click="selectedGroup && testOne(selectedGroup.id, row.original)"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip :text="row.original.enabled ? '浏览对象' : '请先启用实例'">
                    <NuxtButton
                      size="xs"
                      color="info"
                      variant="soft"
                      icon="i-lucide-folder-search"
                      :disabled="!row.original.enabled"
                      @click="() => { navigateTo(`/browse?instance=${row.original.id}`) }"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip text="编辑">
                    <NuxtButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-pencil"
                      @click="selectedGroup && openInstanceEdit(selectedGroup.id, row.original)"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip text="复制">
                    <NuxtButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-copy"
                      @click="selectedGroup && onDuplicateInstance(selectedGroup, row.original)"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip :text="row.original.enabled ? '禁用' : '启用'">
                    <NuxtButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :icon="row.original.enabled ? 'i-lucide-power-off' : 'i-lucide-circle-check'"
                      @click="selectedGroup && onToggleEnabled(selectedGroup, row.original)"
                    />
                  </NuxtTooltip>
                  <NuxtTooltip text="删除">
                    <NuxtButton
                      size="xs"
                      color="error"
                      variant="ghost"
                      icon="i-lucide-trash-2"
                      @click="selectedGroup && onDeleteInstance(selectedGroup, row.original)"
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
        </div>

        <!-- 无选中分组占位 -->
        <div v-else class="flex flex-1 items-center justify-center">
          <p class="text-muted">
            请在左侧选择分组
          </p>
        </div>
      </div>

      <!-- 隐藏的导入文件选择 -->
      <input ref="importInput" type="file" accept=".json" class="hidden" @change="onImportFile">

      <!-- 分组表单弹窗 -->
      <NuxtModal v-model:open="groupModalOpen" title="分组" :dismissible="!groupSubmitting">
        <template #body>
          <NuxtForm
            ref="groupFormRef"
            :state="groupForm"
            :schema="createGroupSchema"
            @submit="onGroupSubmit"
          >
            <NuxtFormField label="名称" name="name" required>
              <NuxtInput v-model="groupForm.name" placeholder="分组名称" class="w-full" />
            </NuxtFormField>
            <NuxtFormField label="描述" name="description" class="mt-4">
              <NuxtTextarea v-model="groupForm.description" placeholder="分组描述（可选）" class="w-full" />
            </NuxtFormField>
          </NuxtForm>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <NuxtButton
              color="neutral"
              variant="ghost"
              label="取消"
              :disabled="groupSubmitting"
              @click="() => { groupModalOpen = false }"
            />
            <NuxtButton
              color="primary"
              label="确定"
              :loading="groupSubmitting"
              @click="groupFormRef?.submit()"
            />
          </div>
        </template>
      </NuxtModal>

      <!-- 实例表单弹窗 -->
      <NuxtModal v-model:open="instanceModalOpen" title="实例" :dismissible="!instanceSubmitting">
        <template #body>
          <NuxtForm
            ref="instanceFormRef"
            :state="instanceForm"
            :schema="createInstanceSchema"
            @submit="onInstanceSubmit"
          >
            <NuxtFormField label="名称" name="name" required>
              <NuxtInput v-model="instanceForm.name" placeholder="实例名称" class="w-full" />
            </NuxtFormField>
            <NuxtFormField label="服务端点" name="endpoint" required class="mt-4">
              <NuxtInput v-model="instanceForm.endpoint" placeholder="http://127.0.0.1:9000" class="w-full" />
            </NuxtFormField>
            <NuxtFormField label="用户名" name="accessKey" required class="mt-4">
              <NuxtInput v-model="instanceForm.accessKey" placeholder="如 minioadmin（Access Key）" class="w-full" />
            </NuxtFormField>
            <NuxtFormField label="密码" name="secretKey" required class="mt-4">
              <NuxtInput
                v-model="instanceForm.secretKey"
                :type="showSecretKey ? 'text' : 'password'"
                placeholder="如 minioadmin（Secret Key）"
                class="w-full"
              >
                <template #trailing>
                  <NuxtButton
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :icon="showSecretKey ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                    class="size-6"
                    @click="(e: MouseEvent) => { e.stopPropagation(); void (showSecretKey = !showSecretKey) }"
                  />
                </template>
              </NuxtInput>
            </NuxtFormField>
            <NuxtFormField label="启用" name="enabled" class="mt-4">
              <NuxtSwitch v-model="instanceForm.enabled" />
            </NuxtFormField>
          </NuxtForm>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <NuxtButton
              color="neutral"
              variant="ghost"
              label="取消"
              :disabled="instanceSubmitting"
              @click="() => { instanceModalOpen = false }"
            />
            <NuxtButton
              color="primary"
              label="确定"
              :loading="instanceSubmitting"
              @click="instanceFormRef?.submit()"
            />
          </div>
        </template>
      </NuxtModal>

      <!-- 确认弹窗 -->
      <NuxtModal v-model:open="confirmOpen" :dismissible="!confirmLoading">
        <template #header>
          <div class="flex items-center gap-2">
            <NuxtIcon name="i-lucide-triangle-alert" class="text-error size-5" />
            <span class="text-highlighted font-semibold">{{ confirmTitle }}</span>
          </div>
        </template>
        <template #body>
          <p class="text-muted">
            {{ confirmDescription }}
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <NuxtButton
              color="neutral"
              variant="ghost"
              label="取消"
              :disabled="confirmLoading"
              @click="() => { confirmOpen = false }"
            />
            <NuxtButton
              color="error"
              label="确认删除"
              :loading="confirmLoading"
              @click="onConfirm"
            />
          </div>
        </template>
      </NuxtModal>
    </template>
  </NuxtDashboardPanel>
</template>
