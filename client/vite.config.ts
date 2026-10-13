import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// В разработке API отдаёт локально запущенный сервер (npm run dev -w server).
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:3004' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.spec.ts'],
  },
});
