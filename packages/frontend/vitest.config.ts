import { defineConfig } from 'vitest/config';

// Note: svelte plugin is intentionally omitted here.
// The current test suite covers pure TypeScript utilities only (trace-tree.ts etc.).
// Component tests will revisit this config and add the svelte plugin when needed (WS5).
export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    alias: {
      $lib: new URL('./src/lib', import.meta.url).pathname,
    },
  },
});
