import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Покрытие считается по всему src, а не только по загруженным тестами файлам.
    // main.ts — тонкая точка входа (запуск Nest), её проверяет e2e-тест и healthcheck.
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
    },
  },
});
