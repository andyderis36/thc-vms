#!/usr/bin/env bash
# Helper container PostgreSQL untuk job `backend` di .gitea/workflows/ci.yml.
#
# Kenapa ada skrip ini: step CI sempat gagal karena container `ci-pg` dihentikan
# proses lain di host VPS beberapa saat setelah dinyatakan ready, sehingga step
# berikutnya kena "FATAL: the database system is shutting down". Setiap
# subcommand di sini idempoten: kalau container hilang/berhenti, container
# dibuat ulang lalu ditunggu sampai benar-benar menerima koneksi.
#
# Pemakaian:
#   bash .gitea/scripts/ci-pg.sh start     # buat container baru + tunggu siap
#   bash .gitea/scripts/ci-pg.sh ensure    # pastikan siap (buat ulang bila perlu)
#   bash .gitea/scripts/ci-pg.sh prepare   # ensure + buat scratch DB + simpan counter
#   bash .gitea/scripts/ci-pg.sh counter   # cetak xact_commit scratch DB
#   bash .gitea/scripts/ci-pg.sh stop      # hapus container
#
# Override lewat env (default mengikuti ci.yml):
#   CI_PG_CONTAINER, CI_PG_IMAGE, CI_PG_PORT, CI_PG_USER, CI_PG_PASSWORD,
#   CI_PG_DB, CI_PG_SCRATCH_DB
set -uo pipefail

CONTAINER="${CI_PG_CONTAINER:-ci-pg}"
IMAGE="${CI_PG_IMAGE:-postgres:18-alpine}"
PORT="${CI_PG_PORT:-5432}"
DB_USER="${CI_PG_USER:-thc_user}"
DB_PASSWORD="${CI_PG_PASSWORD:-thc_password_local}"
DB_NAME="${CI_PG_DB:-thc_vms_db}"
SCRATCH_DB="${CI_PG_SCRATCH_DB:-thc_vms_t03_test}"
XACT_FILE="${CI_PG_XACT_FILE:-/tmp/xact_before}"

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

ready() {
  running && docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1
}

diagnose() {
  err "--- diagnostik container $CONTAINER ---"
  docker ps -a --filter "name=^/${CONTAINER}$" \
    --format 'ps: {{.Names}} | {{.Status}} | {{.Ports}}' >&2 || true
  docker inspect -f \
    'state: status={{.State.Status}} running={{.State.Running}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}' \
    "$CONTAINER" >&2 2>/dev/null || err "inspect: container tidak ditemukan"
  docker logs --tail 50 "$CONTAINER" >&2 2>/dev/null || true
  err "--- akhir diagnostik ---"
}

# Tunggu sampai server benar-benar siap: butuh 3 cek berturut-turut supaya
# container yang sedang shutdown tidak lolos sebagai "ready".
wait_ready() {
  local stable=0 attempt
  for attempt in $(seq 1 90); do
    if ready; then
      stable=$((stable + 1))
      if [ "$stable" -ge 3 ]; then
        return 0
      fi
    else
      stable=0
    fi
    sleep 1
  done
  err "postgres tidak stabil setelah ${attempt} detik"
  diagnose
  return 1
}

start() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -p "${PORT}:5432" \
    -e POSTGRES_USER="$DB_USER" \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -e POSTGRES_DB="$DB_NAME" \
    "$IMAGE" >/dev/null || {
    err "docker run gagal untuk image $IMAGE"
    diagnose
    return 1
  }
  wait_ready || return 1
  log "postgres ready ($CONTAINER, port $PORT)"
}

ensure() {
  if ready; then
    log "postgres sudah siap ($CONTAINER)"
    return 0
  fi
  err "$CONTAINER tidak siap; membuat ulang container"
  start
}

# Tunggu maintenance DB menerima query; menangani sisa proses startup/shutdown.
wait_accepting() {
  local attempt
  for attempt in $(seq 1 30); do
    if docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  err "server tidak menerima koneksi setelah ${attempt} detik"
  diagnose
  return 1
}

prepare() {
  ensure || return 1
  wait_accepting || return 1

  if ! docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$SCRATCH_DB'" | grep -q 1; then
    docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c \
      "CREATE DATABASE $SCRATCH_DB" || {
      err "gagal membuat database $SCRATCH_DB"
      diagnose
      return 1
    }
  fi

  # Counter dibaca dari maintenance DB supaya transaksi probe ini tidak ikut
  # terhitung pada scratch database (dipakai step "Guard against false green").
  if ! docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -tAc \
      "SELECT xact_commit FROM pg_stat_database WHERE datname='$SCRATCH_DB'" \
      | tr -d '[:space:]' > "$XACT_FILE"; then
    err "gagal membaca xact_commit $SCRATCH_DB"
    diagnose
    return 1
  fi
  log "xact_commit before: $(cat "$XACT_FILE")"
}

counter() {
  printf '%s\n' "$(docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -tAc \
    "SELECT xact_commit FROM pg_stat_database WHERE datname='$SCRATCH_DB'" \
    | tr -d '[:space:]')"
}

stop() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

case "${1:-}" in
  start) start ;;
  ensure) ensure ;;
  prepare) prepare ;;
  counter) counter ;;
  stop) stop ;;
  *)
    err "pemakaian: $0 {start|ensure|prepare|counter|stop}"
    exit 2
    ;;
esac
