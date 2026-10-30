# Путеводитель: bybit-bots

Автономная инструкция: достаточно этой папки, исходников и перечисленных защищённых копий. История чатов и центральный каталог не требуются.

[Восстановление](RECOVERY.md) · [Карта файлов и зависимостей](PROJECT_MAP.json)

## Назначение

По [package.json](package.json): Бумажная торговля 11 стратегий и мета-бота на реальном споте Bybit: NestJS-движок и панель на Vue

Обнаруженные языки: Shell, TypeScript, Vue SFC.

## Порядок чтения

1. Локальные AGENTS.md / CLAUDE.md и документы ниже.
2. Манифесты: версии среды, зависимости, команды.
3. Кандидаты точек входа; фактический запуск проверить по манифесту.
4. PROJECT_MAP.json: imports_local от источника к импортируемому файлу; входящие рёбра — потребители модуля.
5. RECOVERY.md: независимые данные, восстановление среды, запуск и критерии приёмки.

- [README.md](README.md)

## Манифесты

- [docker-compose.yml](docker-compose.yml)
- [Dockerfile](Dockerfile)
- [package.json](package.json)
- [client/package.json](client/package.json)
- [server/package.json](server/package.json)

## Кандидаты точек входа

- [client/src/main.ts](client/src/main.ts)
- [server/src/main.ts](server/src/main.ts)

## Основные файлы по локальным импортам

| Файл | Входящих импортов |
|---|---:|
| [server/src/trading/types.ts](server/src/trading/types.ts) | 33 |
| [server/src/config/app-config.ts](server/src/config/app-config.ts) | 19 |
| [server/src/trading/engine.service.ts](server/src/trading/engine.service.ts) | 13 |
| [client/src/format.ts](client/src/format.ts) | 11 |
| [server/src/market/bybit.ts](server/src/market/bybit.ts) | 11 |
| [server/src/storage/state-store.ts](server/src/storage/state-store.ts) | 9 |
| [server/src/storage/trade-log.ts](server/src/storage/trade-log.ts) | 9 |
| [client/src/types.ts](client/src/types.ts) | 8 |
| [server/src/stats/stats.types.ts](server/src/stats/stats.types.ts) | 8 |
| [server/src/trading/ledger.ts](server/src/trading/ledger.ts) | 7 |
| [server/src/stats/stats.service.ts](server/src/stats/stats.service.ts) | 6 |
| [server/src/stats/build-stats.ts](server/src/stats/build-stats.ts) | 6 |

## Проверки

- [client/test/components-extra.spec.ts](client/test/components-extra.spec.ts)
- [client/test/components.spec.ts](client/test/components.spec.ts)
- [client/test/fixtures.ts](client/test/fixtures.ts)
- [client/test/format.spec.ts](client/test/format.spec.ts)
- [server/test/app.e2e.spec.ts](server/test/app.e2e.spec.ts)
- [server/test/backtest.spec.ts](server/test/backtest.spec.ts)
- [server/test/bots.spec.ts](server/test/bots.spec.ts)
- [server/test/bybit-client.spec.ts](server/test/bybit-client.spec.ts)
- [server/test/dca-holder.spec.ts](server/test/dca-holder.spec.ts)
- [server/test/engine-lifecycle.spec.ts](server/test/engine-lifecycle.spec.ts)
- [server/test/engine.spec.ts](server/test/engine.spec.ts)
- [server/test/ledger.spec.ts](server/test/ledger.spec.ts)

## Чтение карты без специальных плагинов

PROJECT_MAP.json — UTF-8 JSON: nodes и edges. Пути файлов относительные. contains обозначает наличие файла; imports_local — статически распознанный импорт; declares_dependency — объявление пакета в манифесте. evidence содержит источник и, где доступно, строку. Карта не исполняет код.

Статус исходного анализа: static-scan-complete; ограничений чтения: 0. Исходный снимок: 2026-10-30T14:47:11.360Z.

После изменения кода перечитайте затронутые файлы: карта является снимком. Отсутствие ребра не доказывает отсутствие зависимости.
