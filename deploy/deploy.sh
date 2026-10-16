#!/usr/bin/env bash
# THC-VMS production deploy — runs ON the Ubuntu VPS via Gitea Actions
# self-hosted runner (single trigger; no webhook alongside it).
#
# Idempotent: safe to re-run. Fails loud on any error. Never overwrites
# an existing .env (root /.env is gitignored, so `git reset --hard`
# cannot touch it either).
#
# Stack deployed (docker-compose.prod.yml): postgres + minio + minio-init
# + migrate (one-shot) + backend + frontend. Backend/frontend images are
# built from backend/Dockerfile and frontend/Dockerfile in this repo.
set -euo pipefail

REPO_DIR="/home/vms/thc-vms"
BRANCH="${DEPLOY_BRANCH:-main}"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE="$REPO_DIR/.env"
TEMPLATE="$REPO_DIR/.env.prod.example"
READY_URL="http://127.0.0.1:8080/api/v1/ready"

cd "$REPO_DIR"

echo "==> sync repo ($BRANCH)"
git fetch origin
git reset --hard "origin/$BRANCH"

if [ ! -f "$ENV_FILE" ]; then
  echo "==> no .env — creating from template (FILL SECRETS, then re-run)"
  cp "$TEMPLATE" "$ENV_FILE"
  echo "ABORT: edit $ENV_FILE and re-run $0"
  exit 1
fi
if grep -q 'CHANGEME' "$ENV_FILE"; then
  echo "ABORT: $ENV_FILE still contains CHANGEME placeholders — fill real secrets first"
  exit 1
fi

echo "==> build + up"
docker compose -f "$COMPOSE_FILE" up -d --build

echo "==> wait backend ready ($READY_URL)"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "$READY_URL" >/dev/null 2>&1; then
    echo "backend ready after ~$((i * 2))s"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ABORT: backend not ready; recent logs:"
    docker compose -f "$COMPOSE_FILE" logs --tail=50 backend migrate
    exit 1
  fi
  sleep 2
done

echo "==> prune dangling images"
docker image prune -f >/dev/null

echo "==> status"
docker compose -f "$COMPOSE_FILE" ps
echo "DEPLOY OK"
