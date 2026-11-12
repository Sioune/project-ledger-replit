import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const mode = process.env.NODE_ENV ?? 'development';
const env = loadEnv(mode, repoRoot, '');
const rawPort = process.env.PORT ?? env.PORT ?? '5173';
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}
const basePath = process.env.BASE_PATH ?? env.BASE_PATH ?? '/';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  envDir: repoRoot,
  base: basePath,
  plugins: [react(), tailwindcss({ optimize: false })],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') }, dedupe: ['react', 'react-dom'] },
  build: { outDir: path.resolve(import.meta.dirname, 'dist/public'), emptyOutDir: true },
  server: {
    port, strictPort: true, host: '0.0.0.0', allowedHosts: ['localhost', '127.0.0.1'],
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
    fs: { strict: true },
  },
  preview: { port, host: '127.0.0.1', allowedHosts: ['localhost', '127.0.0.1'] },
});
