import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';

export default defineConfig({
  plugins: [
    svelte({ hot: false }),
    svelteTesting(),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    alias: {
      $lib: new URL('./src/lib', import.meta.url).pathname,
    },
  },
  resolve: {
    conditions: ['browser'],
  },
});
