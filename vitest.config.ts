import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@personal-budget/finance-core', replacement: fileURLToPath(new URL('./packages/finance-core/src/index.ts', import.meta.url)) },
      { find: '@personal-budget/actual-adapter', replacement: fileURLToPath(new URL('./services/actual-adapter/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: ['**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    coverage: {
      provider: 'v8',
      include: ['packages/finance-core/src/**/*.ts', 'services/actual-adapter/src/**/*.ts', 'services/api/src/**/*.ts'],
      exclude: ['**/index.ts', '**/main.ts'],
      reporter: ['text', 'lcov', 'html'],
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
  },
});
