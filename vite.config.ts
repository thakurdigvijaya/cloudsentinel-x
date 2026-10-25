/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // During local development the browser talks to the same origin; Vite forwards
  // authenticated /api requests to the local Node backend. Cookies remain first-party.
  // Production deployments must configure equivalent /api routing behind HTTPS.
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  test: {
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
    environment: 'node',
  },
});
