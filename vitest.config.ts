import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    maxWorkers: 1,
    testTimeout: 15_000,
  },
})
