#!/bin/sh
# Подключение Telegram: спрашивает токен бота (ввод скрыт), проверяет его,
# находит chat id по сообщению боту, пишет оба в .env и перезапускает контейнер.
# Запускать на сервере в папке проекта или так:
#   ssh -t root@192.168.3.5 sh /srv/appdata/bybit-bots/scripts/set-telegram.sh
set -eu

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Нет .env в $(pwd)"; exit 1; }

printf 'Токен бота от @BotFather (ввод скрыт): '
stty -echo 2>/dev/null || true
read -r TOKEN
stty echo 2>/dev/null || true
echo

# Токен вида 123456789:AAE…: так он безопасно подставляется в sed и URL.
if ! printf '%s' "$TOKEN" | grep -Eq '^[0-9]+:[A-Za-z0-9_-]{30,}$'; then
  echo "Это не похоже на токен: он выглядит как 123456789:AAE… (цифры, двоеточие, буквы)."
  exit 1
fi

API="https://api.telegram.org/bot$TOKEN"
NAME=$(curl -s "$API/getMe" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print(d["result"]["username"] if d.get("ok") else "")
' 2>/dev/null || true)
if [ -z "$NAME" ]; then
  echo "Telegram не принял токен. Проверь его у @BotFather и запусти скрипт ещё раз."
  exit 1
fi
echo "Токен верный, бот: @$NAME"

echo
echo "Открой в Telegram https://t.me/$NAME, нажми «Запустить» (Start) или напиши боту любое сообщение."
printf 'Потом нажми здесь Enter… '
read -r _

FOUND=$(curl -s "$API/getUpdates" | python3 -c '
import sys, json
d = json.load(sys.stdin)
updates = d.get("result", [])
chats = [u["message"]["chat"]["id"] for u in updates if "message" in u]
last = max((u["update_id"] for u in updates), default=-1)
print(chats[-1] if chats else "", last + 1)
' 2>/dev/null || true)
CHAT=${FOUND% *}
NEXT=${FOUND#* }
# Отмечаем сообщения прочитанными: иначе бот после запуска сам ответил бы
# на этот Start ещё одним приветствием.
[ -n "$NEXT" ] && [ "$NEXT" != "0" ] && curl -s "$API/getUpdates?offset=$NEXT" >/dev/null || true
if [ -n "$CHAT" ]; then
  echo "Нашёл твой чат: $CHAT"
else
  printf 'Сообщение не найдено. Введи chat id вручную (его покажет @userinfobot): '
  read -r CHAT
fi
if ! printf '%s' "$CHAT" | grep -Eq '^-?[0-9]+$'; then
  echo "chat id — это число, например 123456789."
  exit 1
fi

BACKUP=".env.bak-$(date +%Y%m%d-%H%M%S)"
cp .env "$BACKUP"
set_var() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
set_var TELEGRAM_BOT_TOKEN "$TOKEN"
set_var TELEGRAM_CHAT_ID "$CHAT"
chmod 600 .env "$BACKUP"
echo "Записал в .env (прежний — в $BACKUP)"

echo "Перезапускаю бота…"
docker compose up -d
echo "Жду первый отчёт (30 секунд)…"
sleep 30
docker compose logs --since 1m bybit-bots 2>&1 | grep -E 'Telegram|Engine\] тик' | tail -8
echo
echo "Готово. В Telegram должно прийти «Боты Bybit на связи» и отчёт; /now — отчёт в любой момент."
