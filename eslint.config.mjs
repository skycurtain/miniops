// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import prettier from 'eslint-config-prettier'

export default withNuxt(
  // Prettier 放最后：仅关闭与格式相关的 ESLint 规则，不报错、不修复
  prettier,
)
