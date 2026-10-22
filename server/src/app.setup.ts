import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from './config/app-config.js';

// Настройка приложения после создания: панель и штатная остановка.
// Вынесена из main.ts, чтобы её можно было проверить тестом.
export function setupApp(app: NestExpressApplication, config: AppConfig, logger = new Logger('Web')): void {
  // Собранная панель (client/dist) раздаётся тем же сервером, что и API.
  if (existsSync(config.clientDir)) {
    // Файлы сборки с хешем в имени кешируются надолго, index.html — нет:
    // после выкладки браузер сразу получает ссылки на новую сборку.
    app.useStaticAssets(config.clientDir, {
      index: 'index.html',
      maxAge: '30d',
      setHeaders: (res, file) => {
        if (file.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
      },
    });
  } else {
    logger.warn(`Панель не собрана: нет ${config.clientDir}`);
  }
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
}
