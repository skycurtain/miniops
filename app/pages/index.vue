<script setup lang="ts">
definePageMeta({
  layout: 'default',
  middleware: () => navigateTo('/manage', { redirectCode: 302 }),
})
</script>

<template>
  <div></div>
</template>
