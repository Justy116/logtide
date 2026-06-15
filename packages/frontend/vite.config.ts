import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  envDir: '../../',
  build: {
    // Svelte 5's runtime emits native private class fields (es2022). esbuild can no
    // longer down-level that to vite's default es2020 target, so build for es2022.
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/v1/otlp': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
