<script lang="ts" setup>
/**
 * 通用确认对话框（配合 useOverlay 使用）
 *
 * 按 Nuxt UI 官方 useOverlay 文档的"Confirm dialog"模式实现：
 * 用户点击按钮时 emit('close', true/false)，由 OverlayProvider
 * resolve overlay.open() 返回的 promise。
 *
 * 调用方：
 *   const overlay = useOverlay()
 *   const modal = overlay.create(ConfirmDialog, { destroyOnClose: true })
 *   const ok = await modal.open({ title, description, ... })
 *   if (!ok) return
 */
interface ConfirmDialogProps {
  open?: boolean
  title?: string
  description?: string
  confirmText?: string
  cancelText?: string
  confirmColor?: string
  confirmIcon?: string
  cancelIcon?: string
}

const props = withDefaults(defineProps<ConfirmDialogProps>(), {
  confirmText: '确认',
  cancelText: '取消',
  confirmColor: 'primary',
})

const emits = defineEmits<{
  close: [value: boolean]
}>()
</script>

<template>
  <NuxtModal
    :open="props.open ?? true"
    :title="props.title ?? '请确认'"
    :description="props.description"
    :dismissible="false"
    :ui="{ footer: 'justify-end' }"
  >
    <template #footer>
      <NuxtButton
        color="neutral"
        variant="outline"
        :icon="props.cancelIcon"
        :label="props.cancelText"
        @click="emits('close', false)"
      />
      <NuxtButton
        :color="props.confirmColor"
        :icon="props.confirmIcon ?? 'i-lucide-check'"
        :label="props.confirmText"
        @click="emits('close', true)"
      />
    </template>
  </NuxtModal>
</template>
