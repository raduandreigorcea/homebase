import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// `npm run dev` serves the page with hot reload and sends /api to the running Homebase service.
export default defineConfig({
  plugins: [preact()],
  base: './',  // relative asset paths: the page also works opened as a file (and behind any path)
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8800', headers: { Host: '127.0.0.1:8800' } } } },
});
