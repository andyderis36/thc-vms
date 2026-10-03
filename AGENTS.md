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

---

## 2. DOMAIN BISNIS & KONTEKS PROYEK

- **Perusahaan**: THC adalah sebuah **Internet Service Provider (ISP)** nasional, **BUKAN** gedung data center tunggal.
- **Topologi Fasilitas**: Fasilitas THC tersebar di banyak **Kantor Cabang, POP (Point of Presence), dan miniPOP**.
- **Tujuan Sistem**: Mengelola izin akses teknisi, vendor mitra (splicing FO, maintenance genset, troubleshooting), dan internal staff yang berkunjung ke shelter atau kantor cabang THC.
- **4 Peran Pengguna (RBAC Multi-Cabang)**:
  1. `super_admin`: Kantor Pusat (Akses global seluruh cabang, monitoring all, kelola master data & user).
  2. `admin`: Admin Kantor Cabang / POP (Terisolasi per `location_id`, approve kunjungan cabangnya, kelola satpam cabangnya, eksekusi check-in/out backup).
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
| **Design System & Base Layouts** | [`docs/stitch-ui/02-design-system.md`](file:///D:/otak-atik/THC/thc-vms/docs/stitch-ui/02-design-system.md) |
| **Spesifikasi 5 Layar Core UI** | [`docs/stitch-ui/04-screen-specs-mvp.md`](file:///D:/otak-atik/THC/thc-vms/docs/stitch-ui/04-screen-specs-mvp.md) |
| **Master Prompts Google Stitch** | [`docs/stitch-ui/06-prompt-templates.md`](file:///D:/otak-atik/THC/thc-vms/docs/stitch-ui/06-prompt-templates.md) |

> ⚠️ **PERINGATAN**: Dilarang mengarang field JSON baru atau query SQL yang bertentangan dengan `docs/4. openapi.yaml` dan `docs/1. Entity Relationship Diagram (ERD).mermaid`.

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
└── AGENTS.md                      # Pedoman ini
```

---

## 6. POLA & LOGIKA KRITIS (*CRITICAL IMPLEMENTATION RULES*)

### 6.1 Multi-Branch Data Scoping (Isolasi Cabang)
- Setiap query data kunjungan (`GET /visits`) atau antrean approval:
  * Jika role = `admin` atau `security`: **Wajib** di-filter ketat oleh backend:
    `WHERE location_id = auth_user.location_id`.
  * Jika role = `super_admin`: Mengizinkan query lintas cabang atau filter opsional `?location_id=...`.
  * Jika role = `vendor`: **Wajib** di-filter ketat oleh backend:
    `WHERE pic_user_id = auth_user.id`.

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
