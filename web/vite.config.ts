import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.SPLAT_API ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': target,
      '/dl': target,
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
