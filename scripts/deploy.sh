#!/usr/bin/env bash
# Выкладка на домашний сервер: тесты → копия кода → пересборка контейнеров.
# .env, data/, logs/ и archive/ на сервере не трогаются — статистика продолжается.
#   DEPLOY_HOST — ssh-адрес сервера, DEPLOY_DIR — папка проекта на нём.
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-root@bots.home}"
DIR="${DEPLOY_DIR:-/srv/appdata/bybit-bots}"

npm test --silent

tar -cf - package.json package-lock.json Dockerfile Dockerfile.web docker-compose.yml \
    .env.example README.md src web scripts \
  | ssh "$HOST" "cd '$DIR' && tar -xf - --no-same-owner && docker compose up -d --build"

ssh "$HOST" "cd '$DIR' && sleep 15 && docker compose ps --format '{{.Name}} {{.Status}}' && docker compose logs --tail 2 bybit-bots"
