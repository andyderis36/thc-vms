#!/usr/bin/env bash
# Sinkronisasi data demo dari mesin dev Windows (local) ke stack produksi VPS.
#
# TUJUAN
#   Memindahkan data kunjungan beserta berkas media (SPK / KTP / selfie) dari
#   database dan object storage LOKAL ke produksi, sehingga aplikasi di VPS
#   menampilkan data yang sama seperti di mesin dev - lewat IP LAN maupun
#   lewat tunnel Cloudflare, tanpa perbedaan.
#
# SIFAT: NON-DESTRUKTIF + IDEMPOTEN
#   Setiap tabel di-merge dengan ON CONFLICT DO NOTHING, jadi data produksi
#   yang sudah ada tidak pernah ditimpa dan script boleh dijalankan ulang.
#   Sebelum merge, database produksi di-backup (rollback dicetak di akhir).
#
# YANG DIPINDAHKAN (8 tabel domain)
#   visit_request, visitor, visit_purpose, status_history, check_in,
#   check_out, notification, audit_log
#
# YANG TIDAK DISENTUH
#   users, location, purpose, vendor, role, schema_migrations
#   -> Master data produksi tetap apa adanya, sehingga kredensial login
#      produksi tidak pernah berubah. Pre-flight memverifikasi bahwa seluruh
#      foreign key dari tabel yang diimpor sudah ada di produksi; bila tidak,
#      script berhenti sebelum menyentuh apa pun.
#
# URL MEDIA
#   URL di CSV masih menunjuk base lokal (http://localhost:9000/...). Script
#   menulis ulang ke S3_PUBLIC_BASE_URL yang SEDANG AKTIF di .env, sehingga
#   berkas tetap resolve. Backend kini menoleransi host apa pun pada URL
#   media (anchor = segmen nama bucket), jadi berkas yang tersimpan sebelum
#   tunnel tetap tampil setelah base berganti.
#
# ASET (dih-transfer manual ke VPS, DI LUAR repo - jangan di-commit):
#   $ARTIFACT_DIR/csv/*.csv         8 tabel di atas (format CSV, header)
#   $ARTIFACT_DIR/objects.tar.gz    dump bucket lokal (struktur bucket/key)
#
# CARA PAKAI (di VPS, user vms):
#   scp -r csv vms@10.11.6.110:/home/vms/thc-vms-sync/
#   scp objects.tar.gz vms@10.11.6.110:/home/vms/thc-vms-sync/
#   bash /home/vms/thc-vms/deploy/sync-local-data.sh
#
# Script ini BUKAN seeder produksi (AGENTS.md §8.5): ia tidak pernah
# menjalankan seed ke produksi, hanya meng-merge dump data dev yang
# operator transfer sendiri.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/vms/thc-vms}"
COMPOSE_FILE="$REPO_DIR/docker-compose.prod.yml"
ENV_FILE="$REPO_DIR/.env"
ARTIFACT_DIR="${ARTIFACT_DIR:-/home/vms/thc-vms-sync}"
CSV_DIR="$ARTIFACT_DIR/csv"
OBJECTS_TAR="$ARTIFACT_DIR/objects.tar.gz"
BACKUP_DIR="$ARTIFACT_DIR/backup"
STAGE_SCHEMA="sync_stage"

# Tabel yang diimpor, urut sesuai dependensi foreign key.
TABLES=(
	visit_request
	visitor
	visit_purpose
	status_history
	check_in
	check_out
	notification
	audit_log
)

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
		sudo -n docker "$@"
		return
	fi
	echo "ERROR: tidak bisa bicara dengan docker daemon (butuh grup docker atau sudo)." >&2
	exit 1
}

# get_env membaca satu variabel dari .env tanpa menyedot seluruh file
# (nilai bcrypt/rahasia bisa mengandung karakter yang merusak `source`).
get_env() {
	local key="$1" line value
	line="$(grep -m1 -E "^${key}=" "$ENV_FILE" 2>/dev/null || true)"
	if [ -z "$line" ]; then
		echo ""
		return
	fi
	value="${line#*=}"
	# buang tanda kutip pembungkus bila ada
	value="${value%\"}"; value="${value#\"}"
	value="${value%\'}"; value="${value#\'}"
	printf '%s' "$value"
}

log() { printf '==> %s\n' "$*"; }
die() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

# --- preflight -------------------------------------------------------------
log "preflight"
[ -f "$ENV_FILE" ] || die "tidak ada $ENV_FILE (stack produksi belum terkonfigurasi)"
[ -d "$CSV_DIR" ] || die "tidak ada $CSV_DIR (CSV lokal belum ditransfer)"
[ -f "$OBJECTS_TAR" ] || die "tidak ada $OBJECTS_TAR (dump objek belum ditransfer)"

PG_USER="$(get_env POSTGRES_USER)"
PG_PASSWORD="$(get_env POSTGRES_PASSWORD)"
PG_DB="$(get_env POSTGRES_DB)"
MINIO_USER="$(get_env MINIO_ROOT_USER)"
MINIO_PASS="$(get_env MINIO_ROOT_PASSWORD)"
BUCKET="$(get_env S3_BUCKET_NAME)"
PROD_BASE="$(get_env S3_PUBLIC_BASE_URL)"
PROD_BASE="${PROD_BASE%/}"

[ -n "$PG_USER" ] && [ -n "$PG_DB" ] || die "POSTGRES_USER/POSTGRES_DB kosong di .env"
[ -n "$MINIO_USER" ] && [ -n "$MINIO_PASS" ] || die "MINIO_ROOT_USER/MINIO_ROOT_PASSWORD kosong di .env"
[ -n "$BUCKET" ] || die "S3_BUCKET_NAME kosong di .env"
[ -n "$PROD_BASE" ] || die "S3_PUBLIC_BASE_URL kosong di .env (base media tidak terdefinisi)"

for t in "${TABLES[@]}"; do
	[ -f "$CSV_DIR/$t.csv" ] || die "CSV $CSV_DIR/$t.csv tidak ada"
	# Baris kosong di akhir CSV membuat COPY gagal ("missing data for column"),
	# dan penyebabnya tidak jelas bagi operator - tolak lebih awal.
	csv_last="$(tail -n 1 "$CSV_DIR/$t.csv" | tr -d '\r')"
	csv_last_data="$(awk 'NF{line=$0} END{print line}' "$CSV_DIR/$t.csv" | tr -d '\r')"
	[ "$csv_last" = "$csv_last_data" ] || die "CSV $t berakhir dengan baris kosong - ekspor ulang tanpa baris kosong di akhir"
done

PG_CONTAINER="$(docker_cli compose -f "$COMPOSE_FILE" ps -q postgres)"
MINIO_CONTAINER="$(docker_cli compose -f "$COMPOSE_FILE" ps -q minio)"
[ -n "$PG_CONTAINER" ] || die "container postgres tidak jalan"
[ -n "$MINIO_CONTAINER" ] || die "container minio tidak jalan"

log "base media aktif: $PROD_BASE"
log "bucket: $BUCKET  (postgres: $PG_DB)"

# --- backup database produksi ---------------------------------------------
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/prod-before-sync-$STAMP.dump"
log "backup database produksi -> $BACKUP_FILE"
docker_cli exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
	pg_dump -U "$PG_USER" -d "$PG_DB" -Fc -f "/tmp/prod-backup.dump"
docker_cli cp "$PG_CONTAINER:/tmp/prod-backup.dump" "$BACKUP_FILE" >/dev/null
docker_cli exec "$PG_CONTAINER" rm -f /tmp/prod-backup.dump
[ -s "$BACKUP_FILE" ] || die "backup kosong - sync dibatalkan"
log "backup ok: $(du -h "$BACKUP_FILE" | cut -f1)"

# --- impor objek object storage -------------------------------------------
# Dilakukan SEBELUM merge DB: bila impor objek gagal, database belum
# berubah sama sekali (objek sisa di bucket hanya sisa, tidak merusak).
log "impor objek ke bucket $BUCKET"
OBJ_TMP="/tmp/sync-objects"
docker_cli exec "$MINIO_CONTAINER" rm -rf "$OBJ_TMP"
docker_cli exec "$MINIO_CONTAINER" mkdir -p "$OBJ_TMP"
docker_cli cp "$OBJECTS_TAR" "$MINIO_CONTAINER:/tmp/sync-objects.tar.gz" >/dev/null
docker_cli exec "$MINIO_CONTAINER" tar -xzf /tmp/sync-objects.tar.gz -C "$OBJ_TMP"
docker_cli exec "$MINIO_CONTAINER" rm -f /tmp/sync-objects.tar.gz
# Nama bucket pada dump lokal bisa berbeda dari bucket produksi; sumbernya
# diambil dari isi tar, targetnya selalu bucket produksi.
SRC_BUCKET="$(docker_cli exec "$MINIO_CONTAINER" sh -c 'ls /tmp/sync-objects/objects | head -1' | tr -d '[:space:]')"
[ -n "$SRC_BUCKET" ] || die "dump objek kosong (tidak ada bucket di dalam tar)"
docker_cli exec -e MC_USER="$MINIO_USER" -e MC_PASS="$MINIO_PASS" -e SRC="$SRC_BUCKET" -e BUCKET="$BUCKET" \
	"$MINIO_CONTAINER" sh -c 'mc alias set prod http://minio:9000 "$MC_USER" "$MC_PASS" >/dev/null && mc cp --recursive "/tmp/sync-objects/objects/$SRC/" "prod/$BUCKET/" >/dev/null'
docker_cli exec -e MC_USER="$MINIO_USER" -e MC_PASS="$MINIO_PASS" -e BUCKET="$BUCKET" \
	"$MINIO_CONTAINER" sh -c 'mc alias set prod http://minio:9000 "$MC_USER" "$MC_PASS" >/dev/null && mc ls --recursive "prod/$BUCKET" | wc -l' \
	| tr -d '[:space:]' | while read -r count; do log "objek di bucket sekarang: $count"; done

# --- staging + merge -------------------------------------------------------
# Tabel staging dibuat dengan LIKE public.<tabel> agar urutan kolomnya
# sama persis dengan produksi; kolom lokal dimuat via \copy (header = nama
# kolom, jadi urutan lokal tidak berpengaruh).
log "menyiapkan schema staging $STAGE_SCHEMA"
psql_run() {
	docker_cli exec -i -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
		psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -v prod_base="$PROD_BASE" "$@"
}

{
	echo "DROP SCHEMA IF EXISTS $STAGE_SCHEMA CASCADE;"
	echo "CREATE SCHEMA $STAGE_SCHEMA;"
	for t in "${TABLES[@]}"; do
		echo "CREATE TABLE $STAGE_SCHEMA.$t (LIKE public.$t);"
	done
} | psql_run -q

# COPY CSV memetakan kolom POSITIONAL, jadi urutan kolom CSV wajib sama
# dengan urutan kolom tabel produksi. Kalau berbeda, data masuk ke kolom yang
# salah - lebih baik berhenti sekarang daripada merusak baris.
log "cek urutan kolom CSV vs produksi"
for t in "${TABLES[@]}"; do
	csv_cols="$(head -n 1 "$CSV_DIR/$t.csv" | tr -d '"\r')"
	db_cols="$(psql_run -t -A -c "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '$t'")"
	[ "$csv_cols" = "$db_cols" ] || die "urutan kolom CSV $t tidak sama dengan produksi (csv: $csv_cols / db: $db_cols)"
done

for t in "${TABLES[@]}"; do
	# COPY FROM STDIN, bukan \copy: file ada di host VPS, sedangkan psql
	# berjalan di dalam container, jadi \copy tidak akan pernah menemukan
	# file-nya. Data dialirkan lewat stdin sehingga path lokal tidak relevan.
	cat "$CSV_DIR/$t.csv" | psql_run -q -c "COPY $STAGE_SCHEMA.$t FROM STDIN WITH (FORMAT csv, HEADER true)"
done
# Pre-flight referensial: setiap foreign key dari staging harus sudah ada
# di produksi. Kalau tidak, merge akan gagal di tengah jalan.
log "cek referential integrity staging -> produksi"
FK_CHECK=$(psql_run -t -A <<-SQL
	SELECT
		(SELECT count(*) FROM $STAGE_SCHEMA.visit_request s LEFT JOIN public.users u ON u.id = s.vendor_user_id WHERE u.id IS NULL) +
		(SELECT count(*) FROM $STAGE_SCHEMA.visit_request s LEFT JOIN public.location l ON l.id = s.location_id WHERE l.id IS NULL) +
		(SELECT count(*) FROM $STAGE_SCHEMA.visit_request s LEFT JOIN public.vendor v ON v.id = s.vendor_id WHERE v.id IS NULL) +
		(SELECT count(*) FROM $STAGE_SCHEMA.visitor s LEFT JOIN public.visit_request r ON r.id = s.visit_request_id WHERE r.id IS NULL) +
		(SELECT count(*) FROM $STAGE_SCHEMA.visitor s LEFT JOIN public.vendor v ON v.id = s.vendor_id WHERE v.id IS NULL) +
		(SELECT count(*) FROM $STAGE_SCHEMA.visit_purpose s LEFT JOIN public.purpose p ON p.id = s.purpose_id WHERE p.id IS NULL) +
		(SELECT count(*) FROM $STAGE_SCHEMA.status_history s LEFT JOIN public.users u ON u.id = s.changed_by WHERE u.id IS NULL) +
		(SELECT count(*) FROM $STAGE_SCHEMA.check_in s LEFT JOIN public.users u ON u.id = s.checked_in_by WHERE u.id IS NULL) +
		(SELECT count(*) FROM $STAGE_SCHEMA.check_out s LEFT JOIN public.users u ON u.id = s.checked_out_by WHERE u.id IS NULL) +
		(SELECT count(*) FROM $STAGE_SCHEMA.notification s LEFT JOIN public.users u ON u.id = s.user_id WHERE u.id IS NULL)
	SQL
)
FK_MISSING="$(printf '%s' "$FK_CHECK" | tr -d '[:space:]')"
[ "$FK_MISSING" = "0" ] || die "ada $FK_MISSING baris staging yang foreign key-nya tidak ada di produksi - master data berbeda, sync dibatalkan"

# Rewrite URL media ke base yang sedang aktif. Query string dipotong
# (URL presigned yang sempat tersimpan di DB tidak pernah ada artinya).
log "menulis ulang URL media ke $PROD_BASE"
psql_run -q <<-SQL
	UPDATE $STAGE_SCHEMA.visit_request
	SET assignment_letter_url = regexp_replace(
		regexp_replace(assignment_letter_url, '\?.*$', ''),
		'^https?://[^/]+/.*?(assignment_letters|id_cards|checkin_photos)/',
		:'prod_base' || '/\1/', '');
	UPDATE $STAGE_SCHEMA.visitor
	SET id_card_photo_url = regexp_replace(
		regexp_replace(id_card_photo_url, '\?.*$', ''),
		'^https?://[^/]+/.*?(assignment_letters|id_cards|checkin_photos)/',
		:'prod_base' || '/\1/', ''),
	photo_url = regexp_replace(
		regexp_replace(photo_url, '\?.*$', ''),
		'^https?://[^/]+/.*?(assignment_letters|id_cards|checkin_photos)/',
		:'prod_base' || '/\1/', '');
	UPDATE $STAGE_SCHEMA.check_in
	SET photo_url = regexp_replace(
		regexp_replace(photo_url, '\?.*$', ''),
		'^https?://[^/]+/.*?(assignment_letters|id_cards|checkin_photos)/',
		:'prod_base' || '/\1/', '');
SQL

log "merge ke produksi (ON CONFLICT DO NOTHING, dalam satu transaksi)"
{
	echo "BEGIN;"
	for t in "${TABLES[@]}"; do
		echo "INSERT INTO public.$t SELECT * FROM $STAGE_SCHEMA.$t ON CONFLICT DO NOTHING;"
	done
	echo "COMMIT;"
} | psql_run -q

psql_run -q -c "DROP SCHEMA IF EXISTS $STAGE_SCHEMA CASCADE;"

# --- verifikasi ------------------------------------------------------------
log "verifikasi"
SUMMARY=$(psql_run -t -A -F'|' <<-SQL
	SELECT 'visit_request', count(*) FROM public.visit_request
	UNION ALL SELECT 'visitor', count(*) FROM public.visitor
	UNION ALL SELECT 'visit_purpose', count(*) FROM public.visit_purpose
	UNION ALL SELECT 'status_history', count(*) FROM public.status_history
	UNION ALL SELECT 'check_in', count(*) FROM public.check_in
	UNION ALL SELECT 'check_out', count(*) FROM public.check_out
	UNION ALL SELECT 'notification', count(*) FROM public.notification
	UNION ALL SELECT 'audit_log', count(*) FROM public.audit_log
	UNION ALL SELECT 'visit_dengan_spk', count(*) FROM public.visit_request WHERE assignment_letter_url IS NOT NULL AND assignment_letter_url <> ''
	UNION ALL SELECT 'visitor_dengan_ktp', count(*) FROM public.visitor WHERE id_card_photo_url IS NOT NULL AND id_card_photo_url <> ''
	UNION ALL SELECT 'visitor_dengan_selfie', count(*) FROM public.visitor WHERE photo_url IS NOT NULL AND photo_url <> ''
SQL
)
printf '%s\n' "$SUMMARY" | while IFS='|' read -r label total; do
	[ -n "$label" ] && printf '    %-22s %s\n' "$label" "$total"
done

SAMPLE=$(psql_run -t -A <<-SQL
	SELECT assignment_letter_url FROM public.visit_request
	WHERE assignment_letter_url IS NOT NULL AND assignment_letter_url <> '' LIMIT 1;
SQL
)
[ -n "$SAMPLE" ] && log "contoh URL media: $SAMPLE"

cat <<-EOF

	SINKRONISASI SELESAI.

	  Database   : $PG_DB (merge non-destruktif, data produksi lama dipertahankan)
	  Objek      : bucket $BUCKET
	  Base media : $PROD_BASE
	  Backup     : $BACKUP_FILE

	  ROLLBACK (kalau perlu mengembalikan kondisi sebelum sinkronisasi):
	    docker exec -e PGPASSWORD='***' $PG_CONTAINER \\
	      pg_restore -U $PG_USER -d $PG_DB --clean --if-exists "$BACKUP_FILE"

	  Catatan: file backup ada di mesin VPS; unduh bila mau disimpan.
	EOF
