<script setup lang="ts">
/**
 * 文件列表卡片（idle 阶段显示）。
 *
 * 通过 inject 获取分发 composable 的共享状态，不使用 props/emits。
 */
import { useInjectDispatch } from '~/composables/use-dispatch'

const dispatch = useInjectDispatch()
const {
  files,
  fileGroups,
  folderExpanded,
  phase,
  readyCount,
  removeFile,
  formatSize,
  fileIcon,
} = dispatch
</script>

<template>
  <div class="border-default bg-default flex min-h-0 flex-1 flex-col rounded-lg border">
    <div class="flex min-h-12 items-center justify-between border-default border-b px-4 py-2.5">
      <div class="flex items-center gap-2">
        <NuxtIcon name="i-lucide-files" class="text-primary size-4" />
        <span class="text-highlighted text-sm font-semibold">文件列表</span>
      </div>
      <span class="text-muted text-xs">
        共 {{ fileGroups.length }} 项（{{ files.length }} 个文件）
        <span v-if="readyCount < files.length" class="text-primary">· 就绪 {{ readyCount }}/{{ files.length }}</span>
      </span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-2">
      <div v-if="!files.length" class="text-muted flex items-center gap-2 py-8 justify-center">
        <NuxtIcon name="i-lucide-inbox" class="size-5" />
        <span>点击"添加文件"或"添加文件夹"选择要分发的文件</span>
      </div>
      <div v-else class="flex flex-col gap-1.5">
        <template v-for="(group, gi) in fileGroups" :key="gi">
          <!-- 文件夹聚合条目 -->
          <div v-if="group.type === 'folder'" class="border-default bg-elevated rounded-md border">
            <div class="flex items-center gap-2 px-3 py-1.5 text-sm">
              <button
                class="flex shrink-0 items-center"
                @click="folderExpanded[group.folderName!] = !folderExpanded[group.folderName!]"
              >
                <NuxtIcon
                  :name="folderExpanded[group.folderName!] ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  class="text-muted size-4"
                />
              </button>
              <NuxtIcon name="i-lucide-folder" class="text-primary size-4 shrink-0" />
              <span class="truncate flex-1 font-mono">{{ group.folderName }}/</span>
              <span class="text-muted text-xs shrink-0">{{ group.items.length }} 个文件</span>
              <span class="text-muted text-xs shrink-0">{{ formatSize(group.totalSize) }}</span>
              <NuxtIcon
                v-if="group.anyUploading"
                name="i-lucide-loader-circle"
                class="text-primary size-4 animate-spin shrink-0"
              />
              <NuxtIcon
                v-else-if="group.anyError"
                name="i-lucide-x-circle"
                class="text-error size-4 shrink-0"
              />
              <NuxtIcon
                v-else
                name="i-lucide-check-circle"
                class="text-success size-4 shrink-0"
              />
              <button
                v-if="phase === 'idle'"
                class="flex shrink-0 items-center text-muted hover:text-error"
                @click="group.items.forEach(f => removeFile(f.id))"
              >
                <NuxtIcon name="i-lucide-x" class="size-3.5" />
              </button>
            </div>
            <div
              v-if="folderExpanded[group.folderName!]"
              class="border-default flex flex-col border-t px-3 py-1"
            >
              <div
                v-for="f in group.items"
                :key="f.id"
                class="flex items-center gap-2 py-0.5 pl-6 text-sm"
              >
                <NuxtIcon :name="fileIcon(f.name)" class="text-muted size-3.5 shrink-0" />
                <span class="text-muted truncate flex-1 font-mono text-xs">{{ f.objectKey }}</span>
                <span class="text-muted text-xs shrink-0">{{ formatSize(f.size) }}</span>
                <NuxtIcon
                  v-if="f.status === 'uploading'"
                  name="i-lucide-loader-circle"
                  class="text-primary size-3.5 animate-spin shrink-0"
                />
                <NuxtIcon
                  v-else-if="f.status === 'error'"
                  name="i-lucide-x-circle"
                  class="text-error size-3.5 shrink-0"
                />
                <NuxtIcon
                  v-else
                  name="i-lucide-check-circle"
                  class="text-success size-3.5 shrink-0"
                />
              </div>
            </div>
          </div>

          <!-- 单文件条目 -->
          <div
            v-else
            class="border-default bg-elevated flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
          >
            <NuxtIcon :name="fileIcon(group.items[0]!.name)" class="text-primary size-4 shrink-0" />
            <span class="truncate flex-1 font-mono">{{ group.items[0]!.objectKey }}</span>
            <span class="text-muted text-xs shrink-0">{{ formatSize(group.items[0]!.size) }}</span>
            <NuxtIcon
              v-if="group.anyUploading"
              name="i-lucide-loader-circle"
              class="text-primary size-4 animate-spin shrink-0"
            />
            <NuxtIcon
              v-else-if="group.anyError"
              name="i-lucide-x-circle"
              class="text-error size-4 shrink-0"
            />
            <NuxtIcon
              v-else
              name="i-lucide-check-circle"
              class="text-success size-4 shrink-0"
            />
            <button
              v-if="phase === 'idle'"
              class="flex shrink-0 items-center text-muted hover:text-error"
              @click="removeFile(group.items[0]!.id)"
            >
              <NuxtIcon name="i-lucide-x" class="size-3.5" />
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
