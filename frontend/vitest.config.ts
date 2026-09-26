import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Unit tests cover PURE LOGIC only (tolerance math, status-badge map,
 * role capability matrix, upload validation). No DOM/React testing here —
 * UI is verified by real-surface QA in a browser.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
  },
})
