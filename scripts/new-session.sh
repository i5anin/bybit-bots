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
echo "Счёт обнулён. Запустите бота — он начнёт с чистого листа."
