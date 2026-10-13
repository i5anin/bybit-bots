#!/usr/bin/env bash
# Выкладка на домашний сервер: тесты → копия кода → пересборка контейнеров.
# .env, data/, logs/ и archive/ на сервере не трогаются — статистика продолжается.
#   DEPLOY_HOST — ssh-адрес сервера, DEPLOY_DIR — папка проекта на нём.
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-root@bots.home}"
DIR="${DEPLOY_DIR:-/srv/appdata/bybit-bots}"

npm run typecheck --silent
npm test --silent

# Код без node_modules и сборок: образ собирается на сервере с нуля.
# --remove-orphans убирает контейнеры сервисов, которых больше нет в compose.
tar -cf - --exclude=node_modules --exclude=dist \
    package.json package-lock.json Dockerfile .dockerignore docker-compose.yml \
    .env.example README.md server client scripts \
  | ssh "$HOST" "cd '$DIR' && tar -xf - --no-same-owner && docker compose up -d --build --remove-orphans"

ssh "$HOST" "cd '$DIR' && sleep 15 && docker compose ps --format '{{.Name}} {{.Status}}' && docker compose logs --tail 3 bybit-bots"
