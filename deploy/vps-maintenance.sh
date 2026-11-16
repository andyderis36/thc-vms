#!/usr/bin/env bash
# Perawatan rutin VPS THC-VMS — dijalankan via cron (lihat docs/8. CI-CD.md).
# Aman: hanya prune build cache + image dangling. Volume, container berjalan,
# dan data produksi TIDAK PERNAH disentuh di sini.
set -euo pipefail

THRESH="${DISK_WARN_PCT:-85}"

docker_cli() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi
  if command -v sg >/dev/null 2>&1 && sg docker -c "docker info" >/dev/null 2>&1; then
    sg docker -c "docker $(printf '%q ' "$@")"
    return
  fi
  echo "ABORT: tidak bisa akses docker API (/var/run/docker.sock)." >&2
  exit 1
}

echo "==> disk sebelum ($(date -u +%FT%TZ))"
df -h / | tail -n 1
USEPCT="$(df --output=pcent / 2>/dev/null | tail -n 1 | tr -dc '0-9')"
[ -z "$USEPCT" ] && USEPCT=0

echo "==> prune build cache"
docker_cli builder prune -af
echo "==> prune image dangling"
docker_cli image prune -f >/dev/null

echo "==> disk sesudah"
df -h / | tail -n 1
if [ "$USEPCT" -ge "$THRESH" ]; then
  echo "WARNING: disk / terpakai ${USEPCT}% (>= ${THRESH}%) — investigasi sebelum deploy berikutnya." >&2
fi
echo "MAINTENANCE OK"
