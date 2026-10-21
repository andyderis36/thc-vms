#!/usr/bin/env bash
# THC-VMS production deploy — runs ON the Ubuntu VPS via Gitea Actions
# self-hosted runner (single trigger; no webhook alongside it).
#
# Idempotent: safe to re-run. Fails loud on any error. Never overwrites
# an existing .env (root /.env is gitignored, so `git reset --hard`
# cannot touch it either).
#
# Stack deployed (docker-compose.prod.yml): postgres + minio (object storage
# S3-compatible) + migrate (one-shot) + backend + frontend + caddy (reverse
# proxy tunggal pada :80). Backend/frontend images are built from
# backend/Dockerfile and frontend/Dockerfile in this repo.
set -euo pipefail

REPO_DIR="/home/vms/thc-vms"
BRANCH="${DEPLOY_BRANCH:-main}"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE="$REPO_DIR/.env"
TEMPLATE="$REPO_DIR/.env.prod.example"
READY_URL="http://127.0.0.1:8080/api/v1/ready"
FRONTEND_URL="http://127.0.0.1/"
SCRIPT_SELF="$(readlink -f "$0")"

cd "$REPO_DIR"

# Akses docker. Runner Gitea Actions = systemd user-service: user yang
# ditambahkan ke group `docker` SETELAH service start tidak mewarisi group
# itu -> CLI docker gagal "permission denied ... /var/run/docker.sock".
# `sg`/`newgrp` membuka shell baru dengan group dari /etc/group (tanpa password).
# Probe WAJIB menyentuh daemon (`docker info`), bukan `docker compose version`
# yang hanya memeriksa CLI tanpa pernah bicara ke socket.
docker_cli() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    echo "==> akses docker lewat 'sudo -n'"
    sudo -n docker "$@"
    return
  fi
  local runner=""
  if command -v sg >/dev/null 2>&1; then
    runner="sg"
  elif command -v newgrp >/dev/null 2>&1; then
    runner="newgrp"
  fi
  if [ -n "$runner" ]; then
    if "$runner" docker -c "docker info" >/dev/null 2>&1; then
      echo "==> docker group tidak terwarisi runner; memakai '$runner docker'"
      "$runner" docker -c "docker $(printf '%q ' "$@")"
      return
    fi
  fi
  echo "ABORT: tidak bisa mengakses docker API (/var/run/docker.sock)." >&2
  echo "       Tambahkan user runner ke group 'docker', lalu restart runner:" >&2
  echo "         sudo usermod -aG docker <user-runner>" >&2
  echo "         systemctl --user restart act_runner" >&2
  exit 1
}

compose() {
  docker_cli compose "$@"
}

# Diagnostik runner — selalu dicetak supaya log CI menjawab "kenapa docker
# socket denied" tanpa perlu akses SSH ke VPS.
echo "==> runner diagnostics"
echo "    uid=$(id -u) gid=$(id -g) user=$(id -un)"
echo "    groups=$(id -Gn 2>/dev/null || echo '?')"
if [ -e /var/run/docker.sock ]; then
  echo "    docker.sock: $(ls -l /var/run/docker.sock)"
  echo "    docker.sock gid=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo '?') mode=$(stat -c '%a' /var/run/docker.sock 2>/dev/null || echo '?')"
else
  echo "    docker.sock: MISSING"
fi
echo "    sg=$(command -v sg || echo none) newgrp=$(command -v newgrp || echo none) sudo=$(command -v sudo || echo none)"
if [ -e /.dockerenv ]; then
  echo "    container: YA (/.dockerenv ada)"
else
  echo "    container: tidak terdeteksi"
fi
echo "    cgroup: $(head -c 160 /proc/1/cgroup 2>/dev/null | tr '\n' ' ')"
echo "    docker info direct: $(docker info >/dev/null 2>&1 && echo OK || echo FAIL)"
if command -v sg >/dev/null 2>&1; then
  echo "    docker info via sg: $(sg docker -c "docker info" >/dev/null 2>&1 && echo OK || echo FAIL)"
fi
if command -v sudo >/dev/null 2>&1; then
  echo "    docker info via sudo -n: $(sudo -n docker info >/dev/null 2>&1 && echo OK || echo FAIL)"
fi

echo "==> sync repo ($BRANCH)"
sync_repo() {
  local before after
  before="$(sha256sum "$SCRIPT_SELF" | awk '{print $1}')"
  git fetch origin
  git reset --hard "origin/$BRANCH"
  after="$(sha256sum "$SCRIPT_SELF" | awk '{print $1}')"
  # `git reset --hard` mengganti file lewat temp-file+rename, jadi bash yang
  # sedang berjalan tetap membaca inode LAMA. Efeknya: script versi lama yang
  # dieksekusi walau repo sudah di-sync ke commit terbaru. Kalau isi script
  # berubah saat sync, jalankan ulang versi yang baru.
  if [ "$before" != "$after" ] && [ -z "${DEPLOY_RESYNCED:-}" ]; then
    export DEPLOY_RESYNCED=1
    echo "==> script berubah setelah sync; eksekusi ulang versi terbaru"
    exec bash "$SCRIPT_SELF" "$@"
  fi
}
sync_repo "$@"

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
# Opsi bootstrap untuk database yang benar-benar kosong (tabel role belum ada
# isi). Seed WAJIB diaktifkan eksplisit di .env dan hanya boleh jalan saat DB
# kosong - di DB yang sudah berisi data, seed akan me-reset password akun demo.
BOOTSTRAP_SEED="$(grep -E '^BOOTSTRAP_SEED=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"[:space:]' || true)"

# --- Bersihkan container orphan dari stack lama -----------------------------
# Stack lama (compose versi sebelumnya / compose dev) bisa masih jalan lalu
# merebut port 80 atau 8080, sehingga `up` gagal "port is already allocated".
# ATURAN KERAS: yang dihapus HANYA container. Volume & data TIDAK PERNAH
# dihapus di sini — data produksi hanya boleh dihapus oleh operator explicit.
PROD_PROJECT="$(grep -E '^name:[[:space:]]+' "$COMPOSE_FILE" | head -n1 | awk '{print $2}')"
PROD_PROJECT="${PROD_PROJECT:-thc-vms-prod}"

echo "==> cleaning legacy containers (volumes & data are NOT touched)"
legacy_rows="$(
  docker_cli ps -a \
    --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Ports}}|{{.Label "com.docker.compose.project"}}'
)"
orphan_count=0
while IFS='|' read -r cid cname cimage cports cproject; do
  [ -z "$cid" ] && continue
  # Container yang bukan milik compose project produksi kita = kandidat.
  # Container non-compose (label kosong) TIDAK boleh disentuh.
  [ -z "$cproject" ] && continue
  [ "$cproject" = "$PROD_PROJECT" ] && continue
  # Hanya container yang jelas milik stack THC-VMS (image atau port produksi).
  is_ours=0
  case "$cimage" in
    postgres:*|minio/*|rustfs/*|redis*|pgbouncer*|golang:*|node:*|caddy:*|nginx:*|thc-vms-*) is_ours=1 ;;
  esac
  # `->` tidak boleh dipakai di pattern `case` (bentrok dengan arrow), jadi
  # pencocokan port lewat grep -E.
  if printf '%s' "$cports" | grep -Eq ':(80|8080|3210|5432)->'; then
    is_ours=1
  fi
  [ "$is_ours" -eq 1 ] || continue
  echo "    removing legacy container: $cname (image=$cimage project=$cproject)"
  docker_cli rm -f "$cid" >/dev/null
  orphan_count=$((orphan_count + 1))
done <<EOF
$legacy_rows
EOF
echo "    legacy containers removed: $orphan_count"

echo "==> build + up"
# Infrastruktur dulu: postgres & minio harus hidup sebelum DB bisa diperiksa, dan
# backend butuh role `security` saat boot (backend/cmd/server/main.go). Kalau DB
# masih kosong, backend exit 1 dan `up` gagal - jadi bootstrap harus lebih dulu.
compose -f "$COMPOSE_FILE" up -d postgres minio

role_count() {
  compose -f "$COMPOSE_FILE" exec -T postgres \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from role"' 2>/dev/null \
    | tr -dc '0-9'
}

roles="$(role_count || true)"
[ -z "$roles" ] && roles=0
if [ "$roles" = "0" ]; then
  echo "==> DB belum berisi master data: migrasi lalu bootstrap"
  compose -f "$COMPOSE_FILE" run --rm --no-deps --build migrate
  roles="$(role_count || true)"
  [ -z "$roles" ] && roles=0
  if [ "$roles" != "0" ]; then
    echo "ABORT: jumlah role tidak terduga setelah migrasi ($roles)" >&2
    exit 1
  fi
  if [ "$BOOTSTRAP_SEED" != "1" ]; then
    echo "ABORT: DB kosong dan BOOTSTRAP_SEED != 1 di .env." >&2
    echo "       Bootstrap manual (sekali):" >&2
    echo "         compose -f $COMPOSE_FILE run --rm --no-deps --build backend ./seeds" >&2
    exit 1
  fi
  echo "==> bootstrap seed (BOOTSTRAP_SEED=1)"
  compose -f "$COMPOSE_FILE" run --rm --no-deps --build backend ./seeds
  echo "PERINGATAN: seed membuat akun demo dengan password demo. Segera rotasi atau hapus sebelum produksi nyata." >&2
fi

if ! compose -f "$COMPOSE_FILE" up -d --build; then
  echo "ABORT: compose up gagal. Log container:" >&2
  compose -f "$COMPOSE_FILE" logs --tail=60 backend migrate minio postgres >&2 || true
  exit 1
fi

echo "==> wait backend ready ($READY_URL)"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "$READY_URL" >/dev/null 2>&1; then
    echo "backend ready after ~$((i * 2))s"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "ABORT: backend not ready; recent logs:" >&2
    compose -f "$COMPOSE_FILE" logs --tail=50 backend migrate >&2 || true
    echo "       Bila log menyebut role/seed (mis. 'resolve security role id')," >&2
    echo "       DB-nya belum ter-seed. Bootstrap manual (lihat docs/7. DEPLOY_VPS.md):" >&2
    echo "         compose -f $COMPOSE_FILE up -d postgres minio" >&2
    echo "         compose -f $COMPOSE_FILE run --rm --no-deps migrate" >&2
    echo "         compose -f $COMPOSE_FILE run --rm --no-deps backend ./seeds" >&2
    echo "         compose -f $COMPOSE_FILE up -d" >&2
    exit 1
  fi
  sleep 2
done

echo "==> wait frontend via caddy ($FRONTEND_URL)"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "$FRONTEND_URL" >/dev/null 2>&1; then
    echo "frontend reachable after ~$((i * 2))s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ABORT: frontend not reachable through caddy; recent logs:" >&2
    compose -f "$COMPOSE_FILE" logs --tail=50 caddy frontend >&2 || true
    exit 1
  fi
  sleep 2
done

echo "==> prune dangling images"
docker_cli image prune -f >/dev/null

echo "==> status"
compose -f "$COMPOSE_FILE" ps
echo "DEPLOY OK"
