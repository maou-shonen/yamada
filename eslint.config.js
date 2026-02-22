import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  markdown: false,
  ignores: ['**/*.test.ts', '**/*.spec.ts'],
})
