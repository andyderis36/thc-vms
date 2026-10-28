# AI CODING AGENT DIRECTIVES (AGENTS.md)
# Project: THC Visitor Management System (VMS) - ISP Edition
# Version: 3.1.0 (September 2026 LTS Tech Stack)

Dokumen ini adalah **pedoman wajib tertinggi (*supreme directive*)** bagi setiap AI Agent (Antigravity, Cursor, Claude Code, Roo Code, Aider, dll) yang bertugas membaca, merancang, atau menulis kode pada repositori ini.

---

## 1. ATURAN EMAS WAJIB (*NON-NEGOTIABLE GOLDEN RULES*)

```text
1. DILARANG KERAS MELAKUKAN GIT COMMIT ATAU GIT PUSH TANPA PERINTAH EKSPLISIT DARI USER!
2. KERJAKAN SETIAP TUGAS DENGAN TELITI, HATI-HATI, TEPAT, DAN PROFESIONAL!
3. TERAPKAN PRINSIP CLEAN CODE, CLEAN ARCHITECTURE, SOLID, DAN KISS (NO OVER-ENGINEERING)!
```

### Penjelasan Praktis Aturan Emas:
- **Git Safety**: Jangan pernah menjalankan `git commit` atau `git push` secara mandiri. Biarkan user yang memeriksa *working tree* atau meminta commit secara sadar.
- **Prinsip KISS (Keep It Simple, Stupid)**: Jangan membuat layer abstraksi yang berlebihan jika tidak diminta. Cukup 5 layar inti MVP dan 14 endpoint utama. Tidak perlu Redis/Kafka/microservices untuk MVP; gunakan background goroutine dan pgxpool connection pool.
- **Prinsip SOLID**: Pisahkan tanggung jawab secara tegas: Handlers hanya urus HTTP request/response; Usecase hanya urus business logic; Repository hanya urus SQL query; Infrastructure hanya urus driver pihak ketiga (MinIO/S3, mailer).

### 1.1 Alur Branch WAJIB (*MANDATORY BRANCHING WORKFLOW*)

```text
main = branch PRODUKSI.  Push ke main = DEPLOY ke VPS.  Selalu bisa di-deploy.
dev  = branch KERJA.     Semua pengembangan (fitur, UI, refactor, hotfix) terjadi di sini.
```

- **`dev` adalah branch kerja default.** Sebelum menyentuh berkas apa pun, agent **WAJIB** menjalankan `git branch --show-current`:
  - hasilnya `dev` → lanjutkan;
  - hasilnya `main` atau branch lain → **BERHENTI**, laporkan ke user, dan **JANGAN** pindah branch secara otomatis. Minta konfirmasi lebih dulu.
- **`main` HANYA boleh maju lewat merge dari `dev`** (`git merge --no-ff dev`). **DILARANG** commit langsung di `main`, termasuk untuk hotfix: hotfix dikerjakan di `dev`, diuji, lalu dikirim ke `main` melalui merge yang sama.
- **Konsekuensinya:** `dev` selalu ancestor dari `main`, sehingga **tidak ada** kewajiban merge-back `main` → `dev` dan tidak ada divergensi yang perlu dikejar.
- **Push ke `dev` tidak pernah men-deploy** — `.gitea/workflows/deploy.yml` hanya memicu pada `branches: [main]`. Push yang tidak sengaja ke `dev` karena itu aman; push `dev` ke `origin` tetap butuh perintah user (Aturan Emas #1).
- **DILARANG** `git push origin main` untuk pekerjaan yang belum selesai atau belum lolos gate. Satu-satunya jalan ke produksi: merge `dev` → `main`, lalu push `main` **atas perintah eksplisit user**.
- **Migrasi database bersifat forward-only.** Migrasi baru di `dev` wajib dicek ulang nomornya saat merge ke `main` agar tidak bentrok dengan migrasi dari jalur lain.

#### 1.1.1 Gate WAJIB sebelum merge `dev` → `main`

```bash
# backend
cd backend && go build ./... && go vet ./... && go test ./...

# frontend
cd frontend && npm run lint && npm run typecheck && npm test
```

Bila salah satu perintah gagal, **DILARANG** merge ke `main`; perbaiki dulu di `dev`.

#### 1.1.2 Runbook: mengirim perubahan ke produksi

```bash
# 1. kerjakan + commit di dev (satu concern per commit)
git switch dev
git add -A && git commit -m "<Area>: <deskripsi>"

# 2. jalankan gate (§1.1.1) — wajib hijau

# 3. kirim ke main
git switch main
git pull --ff-only origin main
git merge --no-ff dev -m "Release: <ringkasan perubahan>"

# 4. push main = DEPLOY produksi (atas perintah eksplisit user)
git push origin main

# 5. kembali ke dev
git switch dev
```

> **Rollback produksi:** `deploy.sh` selalu memaksa working copy VPS ke `origin/main`, sehingga `git reset --hard` manual di VPS hanya sementara dan ditimpa deploy berikutnya. Rollback yang bertahan lama: `git revert` commit yang bermasalah di `main`, lalu `push origin main`. Migrasi tidak di-rollback, jadi revert wajib backward-compatible.

---

## 2. DOMAIN BISNIS & KONTEKS PROYEK

- **Perusahaan**: THC adalah sebuah **Internet Service Provider (ISP)** nasional, **BUKAN** gedung data center tunggal.
- **Topologi Fasilitas**: Fasilitas THC tersebar di banyak **Kantor Cabang, POP (Point of Presence), dan miniPOP**.
- **Tujuan Sistem**: Mengelola izin akses teknisi, vendor mitra (splicing FO, maintenance genset, troubleshooting), dan internal staff yang berkunjung ke shelter atau kantor cabang THC.
- **4 Peran Pengguna (RBAC Multi-Cabang)**:
  1. `super_admin`: Kantor Pusat (Akses global seluruh cabang, monitoring all, kelola master data & user).
  2. `admin`: Admin Kantor Cabang / POP (Terisolasi per `location_id`, approve kunjungan cabangnya, kelola pengawas cabangnya, eksekusi check-in/out backup).
  3. `security`: Petugas Jaga Gerbang/POP (Terisolasi per `location_id`, operasional verifikasi tamu check-in & check-out).
  4. `vendor` (Vendor/Mitra): Customer / Teknisi Vendor Eksternal (Mengajukan izin, melihat status kunjungan miliknya, membawa kartu QR Code).

---

## 3. DOKUMEN SUMBER KEBENARAN TUNGGAL (*SINGLE SOURCES OF TRUTH - SSOT*)

Sebelum menulis kode atau membuat perubahan, agent **WAJIB** membaca dan merujuk file spesifikasi berikut di folder `docs/`:

| Kebutuhan Spesifikasi | File Sumber Kebenaran Tunggal (SSOT) |
|---|---|
| **Alur Bisnis & Aturan MVP** | [`docs/0. PRD - THC Visitor App.md`](file:///D:/otak-atik/THC/thc-vms/docs/0.%20PRD%20-%20THC%20Visitor%20App.md) |
| **Skema Database & Relasi** | [`docs/1. Entity Relationship Diagram (ERD).mermaid`](file:///D:/otak-atik/THC/thc-vms/docs/1.%20Entity%20Relationship%20Diagram%20%28ERD%29.mermaid) |
| **Alur Pengguna & State Status** | [`docs/2. User Flow Diagram/`](file:///D:/otak-atik/THC/thc-vms/docs/2.%20User%20Flow%20Diagram) |
| **Arsitektur Auth & Middleware** | [`docs/3. Arsitektur Auth (Internal vs Eksternal).mermaid`](file:///D:/otak-atik/THC/thc-vms/docs/3.%20Arsitektur%20Auth%20%28Internal%20vs%20Eksternal%29.mermaid) |
| **Kontrak REST API (OpenAPI 3.1)** | [`docs/4. openapi.yaml`](file:///D:/otak-atik/THC/thc-vms/docs/4.%20openapi.yaml) *(Validasi 0-Error)* |
| **Panduan Dev & Seed Data** | [`docs/5. LOCAL_DEV.md`](file:///D:/otak-atik/THC/thc-vms/docs/5.%20LOCAL_DEV.md) |
| **Skenario Uji & QA Checklist** | [`docs/6. QA_CHECKLIST.md`](file:///D:/otak-atik/THC/thc-vms/docs/6.%20QA_CHECKLIST.md) |
| **Pipeline Deploy & Aturan VPS** | [`docs/7. DEPLOY_VPS.md`](file:///D:/otak-atik/THC/thc-vms/docs/7.%20DEPLOY_VPS.md) |

> ⚠️ **PERINGATAN**: Dilarang mengarang field JSON baru atau query SQL yang bertentangan dengan `docs/4. openapi.yaml` dan `docs/1. Entity Relationship Diagram (ERD).mermaid`. Berkas di dalam folder `docs/stitch-ui/` **DILARANG DIEDIT**; koreksi apa pun wajib dilakukan pada codebase atau dokumen SSOT, bukan pada folder arsip tersebut.

### 3.1 Otoritas Desain UI (REVISI — WAJIB DIBACA)

- **`docs/stitch-ui/` SUDAH BASI (*STALE*) dan BUKAN SSOT.** Folder itu adalah *starter kit / boilerplate* awal (spesifikasi Google Stitch) yang hanya dipakai saat proyek baru dimulai. UI yang berjalan saat ini **TIDAK 100% mengikuti** dokumen tersebut.
- Agent **DILARANG** menjadikan `docs/stitch-ui/02-design-system.md`, `04-screen-specs-mvp.md`, atau `06-prompt-templates.md` sebagai acuan radius, warna, tipografi, atau spesifikasi layar. Jangan mengoreksi UI yang sudah jalan agar "cocok" dengan folder itu.
- **Otoritas desain visual yang berlaku adalah pola komponen *jokoui*** (`https://www.jokoui.web.id/components/application`): radius lega, permukaan ber-tint lembut, spasi bersih, elevasi tertahan. **Palet tetap biru THC `#422AD5` (primary) dan magenta `#F43098` (secondary).**
- **Token radius proyek bersifat semantik** (resolusi saat ini): `--radius-control` = 8px (tombol/input/chip/tab/pagination), `--radius-card` = 8px (kartu/panel/menu), `--radius-modal` = 16px, `--radius-badge` = 9999px (pill). Gunakan **nama token** ini; **JANGAN** tulis nilai skala Tailwind mentah (`rounded-lg`/`rounded-md`/`rounded-xl`).
- Badge/status chip memakai gaya **pill** (soft tint). Jangan mengubahnya kembali menjadi persegi 6px atau huruf kapital semua.
- Pengecualian desain ini **hanya** untuk tampilan visual. Aturan bisnis, kontrak API, dan skema data tetap mengacu ke tabel SSOT di atas (`docs/0`, `docs/1`, `docs/4`, `docs/5`, `docs/6`).

---

## 4. TECH STACK RESMI (LTS & STABIL SEPTEMBER 2026)

### Backend (Go Clean Architecture)
- **Go**: `1.27.1` (atau Go `1.26 LTS`)
- **Web Framework**: `Gin v1.12.0`
- **Database Driver**: `pgx/v5` (`v5.11.0`) dengan `pgxpool`
- **SQL Builder / Code Gen**: `sqlc` (Type-safe SQL queries)
- **Database Migration**: `golang-migrate/migrate/v4`
- **Otentikasi**: `golang-jwt/jwt/v5` + `bcrypt`
- **Object Storage SDK**: `github.com/minio/minio-go/v7` (Kompatibel S3 API)
- **Validation**: `go-playground/validator/v10`

### Frontend (Next.js App Router)
- **Framework**: `Next.js 16.3.6 Active LTS` (App Router, TypeScript)
- **Library Inti**: `React 19.3`
- **Styling**: `Tailwind CSS v4.3.3` (Oxide Engine, CSS-First Configuration)
- **Server State / Cache**: `@tanstack/react-query v5.103.2`
- **Form & Validasi**: `react-hook-form v7` + `zod v3`
- **Iconography**: `lucide-react`
- **Toast Notifications**: `sonner`
- **Barcode / QR Scanner**: `html5-qrcode` (Dukungan Live Camera & Scan Image File dari Galeri/Chat)

### Infrastructure & Persistence
- **Relational Database**: `PostgreSQL 18.6`
- **Object Storage**:
  - Local Dev: **MinIO** via Docker (`localhost:9000` S3 API, `localhost:9001` Web Console).
  - Production: AWS S3 / Cloudflare R2 / Self-hosted MinIO via Environment Variables.

---

## 5. STRUKTUR PROYEK (MONOREPO GUIDELINES)

```text
thc-vms/
├── backend/                       # Go Clean Architecture
│   ├── cmd/server/main.go         # Dependency Injection & Server Startup
│   ├── internal/
│   │   ├── domain/                # Entity structs, Custom Errors, Storage/Repo Interfaces
│   │   ├── usecase/               # Pure Business Logic (Visits, Auth, Security)
│   │   ├── repository/            # PostgreSQL sqlc queries & pgxpool implementations
│   │   ├── infrastructure/        # MinIO/S3 Storage Adapter, Mailer
│   │   └── delivery/http/         # Gin Handlers, JWT Middlewares, Route Registrations
│   ├── migrations/                # 000001_init_schema.up.sql, dst.
│   └── seeds/                     # Database seed data (Admin, Security, Lokasi, Purpose)
├── frontend/                      # Next.js 16 App Router
│   ├── src/
│   │   ├── app/                   # App Router Pages & Layouts (Base Layouts)
│   │   ├── features/              # Feature Modules (visits, security, auth)
│   │   │   ├── components/        # Feature-specific components
│   │   │   ├── hooks/             # React Query hooks (useVisits, useCheckin)
│   │   │   └── services/          # Axios / Fetch client wrappers
│   │   ├── components/ui/         # Atomic Reusable UI (Button, Modal, Card, Badge)
│   │   └── lib/                   # Axios instance, Auth context, Utils
│   └── app/globals.css            # Tailwind v4 theme tokens
├── docs/                          # Spesifikasi Dokumen Lengkap (SSOT)
├── dummy-assets/                  # Aset uji siap pakai (KTP, selfie, surat tugas)
└── AGENTS.md                      # Pedoman ini
```

### 5.1 Aset Dummy untuk QA / E2E / Verifikasi Manual

Folder [`dummy-assets/`](dummy-assets) berisi berkas nyata yang **siap dipakai** untuk menguji unggah berkas tanpa membuat aset baru:

| Berkas | Jenis | Pemakaian |
|---|---|---|
| `ktp.jpg` | `image/jpeg` | Foto KTP anggota teknisi |
| `selfie.jpg` | `image/jpeg` | Foto selfie anggota / foto profil |
| `selfie-2.jpeg` | `image/jpeg` | Selfie alternatif (uji ganti foto) |
| `surat-tugas.pdf` | `application/pdf` | Surat Tugas / SPK |

Aturan pakai:
- **WAJIB** memakai berkas dari folder ini untuk QA unggah (foto profil, KTP, selfie, SPK) — jangan membuat gambar/PDF baru di temp.
- Jangan mengubah/menghapus berkas di folder ini; perlakukan sebagai aset read-only.
- Untuk uji unggah berulang, salin dulu ke `$RUN_TMP` bila perlu variasi nama berkas.

---

## 6. POLA & LOGIKA KRITIS (*CRITICAL IMPLEMENTATION RULES*)

### 6.1 Multi-Branch Data Scoping (Isolasi Cabang)
- Setiap query data kunjungan (`GET /visits`) atau antrean approval:
  * Jika role = `admin` atau `security`: **Wajib** di-filter ketat oleh backend:
    `WHERE location_id = auth_user.location_id`.
  * Jika role = `super_admin`: Mengizinkan query lintas cabang atau filter opsional `?location_id=...`.
  * Jika role = `vendor`: **Wajib** di-filter ketat oleh backend:
    `WHERE vendor_user_id = auth_user.id`.

### 6.2 Validasi Jadwal Check-in (Toleransi 2 Jam)
- Pada endpoint `POST /visits/{id}/checkin`:
  * Backend **wajib** memeriksa apakah waktu saat ini berada dalam rentang:
    `[visit.start_date - 2 jam] s/d [visit.end_date + 2 jam]`.
  * Jika di luar jendela toleransi, tolak dengan HTTP `400 Bad Request` dan pesan jelas.

### 6.3 Dual-Role Check-in & Triple-Mode Scanner
- Check-in diizinkan dieksekusi oleh `security` DAN `admin` cabang terkait.
- Scanner barcode frontend (SCR-05) wajib menyediakan tab:
  1. **Kamera Langsung** (`html5Qrcode.start(...)`).
  2. **Upload Gambar dari Galeri** (`html5Qrcode.scanFile(imageFile)`), untuk verifikasi jarak jauh ketika petugas sedang makan siang/patroli.
  3. **Input Teks Manual Visit ID** sebagai fallback.

### 6.4 Penanganan Object Storage (MinIO / S3)
- File yang diunggah (Surat Tugas / SPK, Foto KTP, Bukti Check-in):
  * Ukuran maksimal: **5 MB**.
  * Validasi tipe MIME: `application/pdf`, `image/jpeg`, `image/png`.
  * Simpan object key terstruktur: `assignment_letters/{visit_id}/{filename}` atau `id_cards/{visitor_id}/{filename}`.
  * Backend mengembalikan URL absolut atau presigned URL untuk diakses frontend.

### 6.5 Ergonomi Mobile UI
- Tombol aksi utama (Submit, Check-in, Approve) wajib memiliki touch target tinggi **44px – 52px**.
- Di mobile (< 768px), dilarang menggunakan tabel dengan horizontal scroll; ubah menjadi **Tumpukan Kartu Vertikal (*Card Stack*)**.
- Pada layar tamu (SCR-04), kartu QR Code wajib diposisikan di **PALING ATAS LAYAR (*above-the-fold*)** agar teknisi tidak perlu scroll saat di depan scanner pos.

---

## 7. HAL-HAL YANG DILARANG KERAS (*WHAT AI MUST NEVER DO*)

1. **JANGAN** membuat fitur pendaftaran mandiri publik (self-registration) untuk vendor di MVP. Akun vendor didaftarkan secara manual oleh Admin/Superadmin.
2. **JANGAN** membuat layar terpisah untuk Emergency Evacuation List gedung (sudah digantikan oleh tab *Sedang di Lokasi* pada SCR-02).
3. **JANGAN** menempatkan tombol Approve/Reject/Check-in pada tampilan peran vendor.
4. **JANGAN** membocorkan data kunjungan cabang lain kepada Admin Cabang yang berbeda.
5. **JANGAN** melakukan hardcode URL bucket atau database credentials; selalu gunakan `.env` dan `os.Getenv()`.
6. **JANGAN** mengubah kontrak response JSON dari standar: `{ "success": true, "data": ... }` atau `{ "success": false, "error": { "code": "...", "message": "..." } }`.

---

## 8. ATURAN DEPLOY & CI/CD KE VPS (*DEPLOYMENT RULES*)

1. **JANGAN** commit file `.env` nyata dalam kondisi apa pun (root `/.env` sudah di-ignore; hanya template `.env.prod.example` yang dikomit).
2. **JANGAN** deploy production dengan `docker-compose.yml` (dev); SELALU `docker-compose.prod.yml`.
3. **JANGAN** menambahkan trigger deploy kedua (webhook dilarang — port `9000` tabrakan dengan MinIO dan memicu deploy ganda). Satu-satunya trigger: `.gitea/workflows/deploy.yml` via Gitea Actions.
4. **JANGAN** membuka bucket storage ke publik (`mc anonymous` dilarang); berkas selalu via presigned URL / endpoint backend.
5. **JANGAN** menjalankan seed ke production; migrasi prod HANYA via service `migrate` (`backend/cmd/migrate`), karena server production tidak auto-migrate. Satu-satunya pengecualian: bootstrap pada database yang benar-benar kosong (tabel `role` masih 0 baris) dan HANYA bila operator conscious mengaktifkan `BOOTSTRAP_SEED=1` di `.env` VPS. `deploy.sh` memeriksa jumlah baris `role` lebih dulu, jadi seed tidak akan pernah me-reset password akun yang sudah ada.
6. `deploy.sh` WAJIB menolak deploy bila `.env` hilang atau masih mengandung placeholder `CHANGEME`.
7. `NEXT_PUBLIC_*` frontend dibakar saat build (`--build-arg`); JANGAN mengandalkannya sebagai runtime `environment:`.
8. `main` adalah branch produksi dan satu-satunya branch yang men-deploy. Satu-satunya cara `main` maju adalah merge dari `dev` (§1.1); push ke `dev` tidak pernah memicu deploy.
