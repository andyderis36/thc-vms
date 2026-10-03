# CHECKLIST DEPLOY PRODUCTION (DEPLOY_PROD.md)
# Project: THC Visitor Management System (VMS) - ISP Edition

Dokumen ini adalah daftar periksa wajib sebelum menaikkan THC VMS ke server
production. Deploy lokal/demo (tunnel Cloudflare) sengaja longgar; production
tidak boleh longgar.

> ⚠️ **Wajib restart backend (BE) setiap kali env di bawah diubah.**
> Perubahan env/gin-mode baru berlaku setelah proses BE di-restart manual
> oleh operator — jangan kirim ulang tanpa restart.

---

## 1. JWT_SECRET asli (backend menolak start tanpanya)

Terverifikasi di `backend/internal/config/config.go` (`Load`): bila `JWT_SECRET`
kosong, backend **menolak start** dengan error
`JWT_SECRET is required: refusing to start without a token signing key`.

- [ ] Generate secret acak min. 32 karakter, mis. `openssl rand -hex 32`.
- [ ] Set `JWT_SECRET=<hasil-generate>` di env production.
- [ ] Pastikan nilai contoh lokal (`thc-super-secret-key-2026-...`) TIDAK
      terpakai di production — itu placeholder yang jelas palsu.
- [ ] Simpan secret hanya di secret manager / env server, jangan commit ke git.

## 2. Rate limit login dikunci

- [ ] `AUTH_RATE_LIMIT=5` (default aman di `backend/.env.example`).
- [ ] `AUTH_RATE_WINDOW=1m`.
- [ ] Pastikan TIDAK ada `AUTH_RATE_LIMIT=-1` di production (`-1` mematikan
      limiter — hanya untuk `.env` lokal dev/QA yang gitignored).

## 3. Kredensial DB & S3 di-rotate

- [ ] `DB_USER`, `DB_PASSWORD`, `DB_NAME`: ganti dari nilai lokal
      (`thc_user` / `thc_password_local` / `thc_vms_db`).
- [ ] `DB_SSLMODE`: aktifkan sesuai server Postgres production (jangan
      `disable` bila DB mendukung TLS).
- [ ] `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: ganti dari `minioadmin` —
      isi kredensial S3/R2 asli dari secret manager.
- [ ] `S3_ENDPOINT`, `S3_REGION`, `S3_USE_SSL=true`,
      `S3_PUBLIC_BASE_URL`: sesuaikan ke endpoint storage production.
- [ ] `S3_BUCKET_NAME`: pastikan bucket sudah ada di storage production
      ( backend juga memanggil `EnsureBucket` saat start, tetapi bucket
      production sebaiknya disiapkan eksplisit oleh operator).

## 4. Mode production & Gin release

- [ ] `APP_ENV=production`.
- [ ] `APP_DEBUG=false` (bersama `APP_ENV=production` membuat backend
      berjalan dalam `gin.ReleaseMode`; dev default `local` + `true` tetap
      `gin.DebugMode`). Lihat `backend/cmd/server/main.go`.
- [ ] Verifikasi log start tidak memuat peringatan mode debug.

## 5. Jangan pernah jalankan seed ke production

- [ ] `go run seeds/main.go` HANYA untuk database lokal/QA.
- [ ] Migrasi production: jalankan skema via pipeline migrasi yang disetujui
      operator (backend hanya auto-migrate saat `APP_ENV=local`).
- [ ] Double-check connection string sebelum menjalankan perintah SQL apa pun.

## 6. Bucket MinIO/S3 privat + minio-init (khusus host docker)

- [ ] Service `minio-init` (image `minio/mc`) di `docker-compose.yml` hanya
      membuat bucket `thc-vms-bucket` bila belum ada — sekali jalan
      (`restart: "no"`).
- [ ] Bucket TETAP privat: tidak ada perintah `mc anonymous set` karena
      backend melayani berkas lewat presigned URL ber-TTL
      (`S3_PRESIGN_TTL_MINUTES`, default 15 menit).
- [ ] Jangan set bucket public/anonymous-download di console MinIO/S3.

## 7. Tunnel demo vs domain permanen

- [ ] Demo via tunnel (mis. cloudflared): daftarkan URL tunnel FE di
      `CORS_ALLOWED_ORIGINS` backend (koma-dipisah), lalu restart BE.
- [ ] Production sungguhan: pakai domain permanen + TLS (jangan mengandalkan
      URL tunnel sementara yang berubah-ubah).
- [ ] `S3_PUBLIC_BASE_URL` dan `NEXT_PUBLIC_API_BASE_URL` (frontend) wajib
      menunjuk URL production yang benar, bukan `localhost`.

---

## Perintah validasi (tanpa me-restart apa pun)

```bash
# Validasi sintaks compose (tidak menjalankan container)
docker compose config

# Build + vet backend
cd backend
go build ./...
go vet ./...
```

Hak Cipta © 2026 PT THC Indonesia (Internet Service Provider).
