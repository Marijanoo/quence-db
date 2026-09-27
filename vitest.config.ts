import { defineConfig, configDefaults } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, 'dist-electron/**'],
    // The opt-in database tests create and drop whole databases, which is slow when they all run at once
    testTimeout: 30_000,
  },
})
