#!/bin/sh
# Начать новую сессию: прежние результаты — в архив, счёт с нуля.
#
# Нужно потому, что после долгого простоя разрыв цены приписывается
# стратегиям: позиция куплена по старой цене, закрывается по текущей.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

STAMP=$(date +%Y%m%d-%H%M)
DEST="archive/session-$STAMP"

# Пара — из .env, если в окружении не задана: подпись архива иначе всегда BTCUSDT.
if [ -z "${SYMBOL:-}" ] && [ -f .env ]; then
    SYMBOL=$(sed -n 's/^SYMBOL=//p' .env | tail -n 1)
fi

# Работающий бот держит счёт в памяти и записал бы его обратно через минуту,
# а логи пересоздал бы без заголовков. На время переноса контейнеры стоят.
RESTART=""
if command -v docker >/dev/null 2>&1 && [ -n "$(docker compose ps -q --status running 2>/dev/null)" ]; then
    echo "Останавливаю контейнеры на время переноса…"
    docker compose stop
    RESTART=1
fi

if [ ! -f data/state.json ] && [ ! -f logs/equity.csv ]; then
    echo "Архивировать нечего — сессия и так пустая."
else
    mkdir -p "$DEST"
    for f in data/state.json data/notify-state.json logs/equity.csv \
             logs/trades.csv logs/runs.csv; do
        [ -f "$f" ] && mv "$f" "$DEST/" && echo "  в архив: $f"
    done
    # Сводка рядом с данными: через месяц по именам файлов уже не вспомнить.
    {
        echo "Сессия закрыта: $(date '+%Y-%m-%d %H:%M')"
        echo "Инструмент: ${SYMBOL:-BTCUSDT}"
    } > "$DEST/README.txt"
    echo "Архив: $DEST"
fi

rm -f logs/*.csv.bak 2>/dev/null || true

if [ -n "$RESTART" ]; then
    docker compose start
    echo "Счёт обнулён, контейнеры снова запущены."
else
    echo "Счёт обнулён. Запустите бота — он начнёт с чистого листа."
fi
