# bybit-bots

10 ботов-стратегий на Bybit Testnet, каждый со своим виртуальным
балансом 100 у.е. (бумажная торговля).

Котировки — реальные с публичного REST Bybit Testnet (без ключей).
Сделки исполняются только в локальном леджере, реальных ордеров
бот не выставляет.

## Стратегии

1. SMA Crossover (10/30)
2. EMA Crossover (9/21)
3. RSI (14, 30/70)
4. MACD (12/26/9)
5. Bollinger Bands (20, 2σ)
6. Stochastic Oscillator (14, 20/80)
7. Donchian Breakout (20)
8. Mean Reversion (Z-score 20)
9. EMA Ribbon (5/10/15/20/25)
10. Martingale-lite (1% шаг)

Сетка (`src/strategies/grid.js`) реализована, но не подключена к
запуску — можно подменить любую из 10 в `src/index.js`.

## Запуск

```bash
cp .env.example .env
npm install
npm start
```

`.env` не требует API-ключей для текущего режима. Поля
`BYBIT_TESTNET_API_KEY`/`SECRET` зарезервированы на будущее, если
понадобится перейти на реальные ордера на тестовой сети.

## Параметры (.env)

- `SYMBOL` — торговая пара, по умолчанию `BTCUSDT`
- `INTERVAL` — таймфрейм свечей в минутах
- `START_BALANCE` — стартовый виртуальный баланс на бота
- `POLL_MS` — частота опроса рынка

## Запуск в Docker

```bash
cp .env.example .env
docker compose up -d --build
```

Логи (`logs/equity.csv`, `logs/trades.csv`) пишутся в смонтированную
папку `./logs` на хосте — доступны для анализа без захода в контейнер.

Остановить: `docker compose down`.
