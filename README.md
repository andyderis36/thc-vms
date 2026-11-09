# THC Visitor Management System (VMS) - ISP Edition
> **Sistem Manajemen Izin Akses & Kunjungan Fasilitas ISP Terdistribusi (Kantor Cabang, POP, dan miniPOP)**  
> *Versi 3.1.0 — September 2026 LTS Tech Stack*

---

## 🏢 1. Latar Belakang & Domain Bisnis

**THC** adalah sebuah **Internet Service Provider (ISP)** nasional. Berbeda dengan gedung data center tunggal, fasilitas THC tersebar di berbagai kota yang mencakup:
- **Kantor Pusat (*Head Office*) & Kantor Cabang (*Branch Office*)**
- **Point of Presence (POP)**: Shelter distribusi transmisi FO/Wireless utama.
- **miniPOP**: Shelter tower/kabinet distribusi lokal.

Sistem ini dirancang khusus untuk mengelola izin masuk teknisi internal, vendor mitra (*splicing fiber optik, maintenance genset, troubleshooting router/switch*), serta tamu kedinasan dengan pengawasan ketat, pelacakan digital real-time, dan isolasi data per cabang (*multi-branch scoping*).

---

## 👥 2. Empat Peran Pengguna (RBAC Multi-Cabang)

1. **`super_admin` (Kantor Pusat)**:
   - Pengawasan nasional lintas seluruh kantor cabang dan POP.
   - Mengelola master data (kantor, POP, tujuan kunjungan, user admin).
2. **`admin` (Admin Kantor Cabang / POP)**:
   - Terisolasi pada cabang penugasannya (primary `location_id` + coverage `user_locations` untuk multi-branch).
   - Menyetujui/menolak permohonan kunjungan (*approval workflow*).
   - Mengelola akun pengawas di cabangnya & eksekusi check-in cadangan (*dual-role*).
3. **`security` (Petugas Jaga Pos / Shelter)**:
   - Terisolasi pada cabang penugasannya (primary `location_id` + coverage `user_locations` untuk multi-branch).
   - Operasional harian verifikasi tamu check-in & check-out via *Triple-Mode QR Scanner*.
4. **`vendor` (Vendor/Mitra — Customer / Teknisi Vendor Mitra Eksternal)**:
   - Mengajukan permohonan izin kunjungan fasilitas THC.
   - Mengunggah Surat Tugas (SPK) resmi dan data teknisi pengiring.
   - Memegang kartu pas masuk digital (QR Code) siap scan di pos jaga.

---

## 🛠️ 3. Tech Stack Resmi (September 2026 LTS)

### Backend (Go Clean Architecture)
- **Bahasa**: `Go 1.27.1` (atau `Go 1.26 LTS`)
- **HTTP Framework**: `Gin Web Framework v1.12.0`
- **Database Driver**: `pgx/v5` (`v5.11.0`) dengan `pgxpool` *connection pool*
- **SQL Code Gen**: `sqlc` (Type-safe SQL queries)
- **Migrasi Skema**: `golang-migrate/migrate/v4`
- **Otentikasi & Enkripsi**: `golang-jwt/jwt/v5` + `bcrypt`
- **Object Storage**: `github.com/minio/minio-go/v7` (Kompatibel S3 API)
- **Validasi Input**: `go-playground/validator/v10`

### Frontend (Next.js 16 App Router)
- **Framework**: `Next.js 16.3.6 Active LTS` (App Router, TypeScript)
- **UI Library**: `React 19.3`
- **Styling Engine**: `Tailwind CSS v4.3.3` (Oxide Engine, CSS-First Configuration)
- **Server Cache & State**: `@tanstack/react-query v5.103.2`
- **Form & Validasi**: `react-hook-form v7` + `zod v3`
- **Iconography**: `lucide-react`
- **Barcode & QR Scanner**: `html5-qrcode` (Live Camera, Upload Gambar Galeri/WA, Manual Fallback)
- **Notifikasi Toast**: `sonner`

### Persistensi & Infrastruktur
- **Relational Database**: `PostgreSQL 18.6`
- **Object Storage**:
  - Dev Lokal: **MinIO** via Docker (`localhost:9000`, console: `localhost:9001`).
  - Produksi: AWS S3 / Cloudflare R2 via *Environment Variables*.

---

## 📱 4. Lima Layar Inti MVP & Base Layouts

| Kode Layar | Nama Layar | Pengguna Utama | Fokus Fungsionalitas |
|---|---|---|---|
| **SCR-01** | Layar Masuk (*Login Screen*) | Semua Role | Autentikasi email & password + pemisahan layout RBAC |
| **SCR-02** | Dashboard Operasional & Antrean Izin | Admin Cabang & Superadmin | Filter perizinan (`requested`, `approved`, `visiting`) & modal pengawas |
| **SCR-03** | Formulir Pengajuan Kunjungan | Vendor & Admin | Input form bertahap, multi-teknisi, & upload Surat Tugas SPK (PDF/Img <= 5MB) |
| **SCR-04** | Status Kunjungan & Pas Masuk QR | Vendor | Kartu QR *above-the-fold* untuk disodorkan ke scanner pengawas pos |
| **SCR-05** | Layar Gerbang Masuk & Scanner QR | Security & Admin | *Triple-Mode Scanner*: Kamera live, upload foto galeri/chat WA, dan input tiket manual |

> **Halaman back-office (di luar 5 layar inti, memakai ulang permukaan SCR-02):**
> `/approvals` (antrean approval, admin+superadmin), `/security` (kelola pengawas, admin+superadmin),
> `/facilities` + `/coordinators` + `/vendor-registrations` (superadmin), `/profile` (semua peran),
> `/verify-email` (konfirmasi ganti email), `/qr` (resolver tiket QR vendor → SCR-04).
> (`/users` dihapus → 404; filter peran pindah ke kolom "Peran" di `/coordinators`.)

### Arsitektur Base Layout Shell
- `SHELL-01`: **Superadmin Shell** (Dark Sidebar 260px + Dropdown Switcher Cabang Nasional).
- `SHELL-02`: **Branch Admin Shell** (Clean White Sidebar 250px + Badge Nama Cabang Terkunci).
- `SHELL-03`: **Security Kiosk Shell** (Top Bar 70px Industri Kontras Tinggi + Jam Digital + Counter Tamu di Lokasi. **Zero Sidebar**).
- `SHELL-04`: **Vendor Mobile Shell** (Bottom Navigation Bar 64px dengan tombol aksi `+ Ajukan` melayang di tengah).

---

## 🚀 5. Memulai Pengembangan Lokal (*Quick Start*)

Panduan lengkap, kredensial akun uji coba, dan daftar dummy cabang tersedia di [`docs/5. LOCAL_DEV.md`](docs/5.%20LOCAL_DEV.md).

```bash
# 1. Jalankan PostgreSQL 18, MinIO S3, dan (opsional) Mailpit lokal
docker compose up -d

# 2. Migrasi database & Seeder (di folder backend/)
cd backend
migrate -path migrations -database "postgres://thc_user:thc_password_local@localhost:5432/thc_vms_db?sslmode=disable" up
go run seeds/main.go

# 2b. Backfill notifikasi persisted (one-off, idempotent) — setelah seeder
go run cmd/backfill-notifications/main.go

# 3. Jalankan Backend Go
#    (set FRONTEND_BASE_URL=http://localhost:3210 di backend/.env untuk tautan
#     verifikasi ganti email; SMTP_DRY_RUN=true bila tanpa Mailpit)
go run cmd/server/main.go
# API aktif di http://localhost:8080/api/v1

# 4. Jalankan Frontend Next.js (di folder frontend/)
cd ../frontend
npm install
npm run dev
# Web aktif di http://localhost:3210

# 5. (Opsional) E2E Playwright
#    e2e.cmd (root repo) = wrapper dengan preflight/autostart; npm run e2e = langsung
```

---

## 📚 6. Daftar Sumber Kebenaran Tunggal (*Documentation SSOT*)

| File Dokumen | Deskripsi Isi Dokumen |
|---|---|
| [`AGENTS.md`](AGENTS.md) | **Supreme Directive untuk AI Agent**: Aturan emas git, arsitektur, larangan, & standar koding |
| [`docs/0. PRD - THC Visitor App.md`](docs/0.%20PRD%20-%20THC%20Visitor%20App.md) | Product Requirement Document resmi v3.1 (ISP Scope, RBAC, Dual-Role Check-in) |
| [`docs/1. Entity Relationship Diagram (ERD).mermaid`](docs/1.%20Entity%20Relationship%20Diagram%20(ERD).mermaid) | Skema relasional PostgreSQL, 12+ entitas MVP (termasuk `user_locations` untuk multi-branch scope dan `vendor_registration_notices` untuk antrean pendaftaran vendor), foreign key, & index indexing |
| [`docs/2. User Flow Diagram/`](docs/2.%20User%20Flow%20Diagram/) | Alur pengguna (2.1 Request, 2.2 Approval, 2.3 Check-in, 2.4 Reschedule, 2.6 Auto-rules) |
| [`docs/3. Arsitektur Auth (Internal vs Eksternal).mermaid`](docs/3.%20Arsitektur%20Auth%20(Internal%20vs%20Eksternal).mermaid) | Arsitektur JWT, Scoping Cabang, dan Integrasi MinIO Storage |
| [`docs/4. openapi.yaml`](docs/4.%20openapi.yaml) | Kontrak REST API spesifikasi OpenAPI 3.1.0 (*Validasi 0-Error*) |
| [`docs/5. LOCAL_DEV.md`](docs/5.%20LOCAL_DEV.md) | Panduan lokal Docker, env variables, master seed data, dan kredensial uji coba |
| [`docs/6. QA_CHECKLIST.md`](docs/6.%20QA_CHECKLIST.md) | Matriks pengujian RBAC, isolasi cabang, toleransi 2 jam, dan batas file MinIO |

> ⚠️ **Otoritas desain UI**: pola komponen **jokoui** (`https://www.jokoui.web.id/components/application`) — radius lega, permukaan ber-tint lembut, spasi bersih, elevasi tertahan. Palet tetap biru THC `#422AD5` (primary) + magenta `#F43098` (secondary). Folder `docs/stitch-ui/` **sudah basi (*stale*)** dan hanya merupakan arsip *starter kit* awal — **bukan** acuan radius, warna, tipografi, atau spesifikasi layar (lihat `AGENTS.md` §3.1).

---

## ⚖️ 7. Lisensi & Hak Cipta
Hak Cipta © 2026 PT THC Indonesia (Internet Service Provider). Semua hak dilindungi undang-undang.
