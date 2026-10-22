import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { setupApp } from './app.setup.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';

// Точка входа: только запуск. Логика настройки — в app.setup.ts (с тестами),
// сам запуск проверяет e2e-тест приложения и healthcheck контейнера.
/* v8 ignore start */
// .env рядом с запуском — для локальной работы; в Docker переменные приходят
// из env_file, и файла внутри контейнера нет.
if (existsSync('.env')) process.loadEnvFile('.env');

const app = await NestFactory.create<NestExpressApplication>(AppModule);
const config = app.get<AppConfig>(APP_CONFIG);
setupApp(app, config);
await app.listen(config.port);
new Logger('Web').log(`панель и API на порту ${config.port}`);
/* v8 ignore stop */
