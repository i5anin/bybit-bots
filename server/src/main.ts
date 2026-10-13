import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';

// .env рядом с запуском — для локальной работы; в Docker переменные приходят
// из env_file, и файла внутри контейнера нет.
if (existsSync('.env')) process.loadEnvFile('.env');

const app = await NestFactory.create<NestExpressApplication>(AppModule);
const config = app.get<AppConfig>(APP_CONFIG);

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
  new Logger('Web').warn(`Панель не собрана: нет ${config.clientDir}`);
}

app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
await app.listen(config.port);
new Logger('Web').log(`панель и API на порту ${config.port}`);
