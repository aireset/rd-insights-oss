import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 22500, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:22501', changeOrigin: true } } },
  test: { environment: 'jsdom', globals: true, include: ['src/**/*.test.{ts,tsx}'] },
});
