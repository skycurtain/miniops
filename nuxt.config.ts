// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  app: {
    head: {
      title: 'miniops',
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  modules: ['@vueuse/nuxt', '@nuxt/ui', '@nuxt/eslint'],
  css: ['~/assets/css/main.css'],
  ui: {
    prefix: 'Nuxt',
    fonts: false,
  },
  colorMode: {
    preference: 'light',
    fallback: 'light',
  },
  nitro: {
    preset: 'bun',
  },
})
