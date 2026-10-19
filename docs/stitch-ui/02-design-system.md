> ⛔ **ARSIP — BUKAN SUMBER KEBENARAN (NON-SSOT). JANGAN DIEDIT.**
>
> Dokumen ini adalah *starter kit* desain Google Stitch dari awal proyek dan **sudah basi**: isinya tidak lagi mencerminkan UI yang benar-benar berjalan. `radius`, warna, tipografi, dan spesifikasi layarnya **tidak boleh** dipakai sebagai acuan.
>
> - Otoritas desain visual yang berlaku: pola komponen **jokoui** (`https://www.jokoui.web.id/components/application`) + palet tetap THC `#422AD5` (primary) dan `#F43098` (secondary) — lihat `AGENTS.md` §3.1.
> - Kebenaran bisnis, data, dan kontrak API: `docs/0. PRD - THC Visitor App.md`, `docs/1. Entity Relationship Diagram (ERD).mermaid`, `docs/4. openapi.yaml`.
> - Alur kerja yang berlaku: perubahan dibuat **di codebase** lebih dulu, lalu docs/PRD disinkronkan menyusul — bukan sebaliknya.
> - Perlu menyelaraskan sesuatu di sini? **Jangan** — perbarui SSOT yang disebut di atas.

# Design System – THC Visitor Management System (VMS)

---

## 1. Identitas Brand & Nilai Visual

- **Nama Brand**: Trans Hybrid Communication (THC)
- **Nama Aplikasi**: THC Visitor Management System (VMS)
- **Karakter Desain**: Bersih (*clean*), profesional, industrial, minimal, kontras tinggi, modern.
- **Identitas Warna**: Ungu-biru `#422AD5` sebagai warna korporat utama (*primary*), didukung magenta `#F43098` (sekunder) dan teal `#00D1BB` (aksen). Merah dan hijau **bukan** warna brand — hanya dipertahankan sebagai sinyal fungsional (lihat §2.7).
- **Bahasa Antarmuka**: Bahasa Indonesia (Standar Profesional).
- **Target Perangkat**:
  - Desktop: THC Admin & Super Admin (Resolusi >= 1024px)
  - Tablet Landscape: Security Gate (Resolusi 768px – 1024px)
  - Mobile: Vendor/Mitra (Resolusi < 768px)

---

## 2. Palet Warna (Tailwind CSS Tokens)

### 2.1 Warna Utama (Brand Primary — Ungu-Biru THC)
- **Primary Main**: `#422AD5` (Ungu-Biru Trans Hybrid Communication)
- **Primary Dark/Hover**: `#3824B5` (varian gelap se-hue; teks `#E0E7FF` tetap terbaca dengan kontras ≈ 8:1 — aman WCAG AA)
- **Primary Surface/Soft**: `#E0E7FF` (tint lembut dari keluarga *primary-content*)
- **Primary Content / Teks di atas Primary**: `#E0E7FF`

### 2.2 Warna Sekunder & Aksen
- **Secondary**: `#F43098` (magenta) — teks di atasnya `#FFFFFF`
- **Accent**: `#00D1BB` (teal) — teks di atasnya `#09090B` (netral gelap)

### 2.3 Warna Netral (Neutrals)
- **Background Halaman (Base)**: `#FFFFFF`
- **Background Sekunder / Permukaan Alternatif**: `#F8F8F8`
- **Background Kartu & Panel**: `#FFFFFF`
- **Garis Batas (Border Light, Border Mid / Divider)**: `#EEEEEE`
- **Teks Utama (Text Primary)**: `#18181B`
- **Teks Sekunder (Text Secondary)**: `#52525B` (zinc-600 — kontras ≈ 7,7:1 di atas putih, lolos WCAG AA)
- **Teks Muted (Placeholder / Caption)**: `#71717A` (zinc-500 — kontras ≈ 4,8:1 di atas putih, lolos WCAG AA)
- **Netral Kuat (Neutral / Dasar Skala Gelap)**: `#09090B`

### 2.4 Warna Status (Sinyal Aplikasi)
- **Success**: `#00D193`
- **Warning**: `#F9B800`
- **Error**: `#FF657F`
- **Info**: `#00BAFC`

> Warna status murni di atas adalah sinyal merek; bentuk tampilan di antarmuka (badge) memakai pasangan warna tabel §2.5 agar kontras teks tetap terjaga.

### 2.5 Status Badge Mapping (Siklus Kunjungan)

| Status Kunjungan | Background Badge | Text Color | Makna Operasional |
|---|---|---|---|
| `requested` | `#DBEAFE` (Biru Terang) | `#1E40AF` (Biru Tua) | Permohonan baru masuk |
| `approved` | `#DCFCE7` (Hijau Terang) | `#166534` (Hijau Tua) | Disetujui, siap dikunjungi |
| `visiting` | `#DBEAFE` (Biru Terang) | `#1E40AF` (Biru Tua) | Tamu sedang berada di lokasi |
| `completed` | `#DCFCE7` (Hijau Terang) | `#166534` (Hijau Tua) | Selesai & sudah check-out |
| `not_visit` | `#FEE2E2` (Merah Terang) | `#991B1B` (Merah Tua) | Tidak hadir pada hari-H (*no show*) |
| `rejected` | `#FEE2E2` (Merah Terang) | `#991B1B` (Merah Tua) | Ditolak oleh admin |
| `cancelled` | `#F3F4F6` (Abu Terang) | `#6B7280` (Abu Tua) | Dibatalkan sebelum hari-H |
| `rescheduled` | `#FEF3C7` (Kuning Terang)| `#92400E` (Kuning Tua)| Jadwal digeser |

### 2.6 Skala Gelap Shell (Diturunkan dari Neutral `#09090B`)
- **Sidebar SHELL-01 (base)**: `#09090B`
- **Item Sidebar Aktif (SHELL-01)**: `#27272A` (selalu lebih terang dari base — hierarki *base < active*)
- **Topbar Kiosk SHELL-03**: `#18181B`

### 2.7 Pengecualian Fungsional (*Functional Exceptions*)
- **Check-in**: `#16A34A` (tombol "CHECK-IN MASUK" SCR-05).
- **Check-out / Danger**: `#DC2626` (tombol "CHECK-OUT KELUAR", aksi Reject/Cancel).
- Kedua warna di atas **sengaja di luar palet brand**: keduanya sinyal operasional gerbang yang sudah dikenali petugas, bukan warna identitas.
- **QR Code (SCR-04)**: selalu hitam `#000000` di atas putih `#FFFFFF` demi kontras pemindaian — dilarang di-rebrand.
- Label peringatan fungsional (mis. badge status `Ditolak`, ikon berkas PDF, toast error) mengikuti pasangan error/`#DC2626`, bukan warna brand.

---

## 3. Tipografi

- **Font Family**: `Inter`, system-ui, -apple-system, sans-serif
- **Heading 1**: 24px / Bold (700) / Line-height 1.3
- **Heading 2**: 20px / Semibold (600) / Line-height 1.35
- **Heading 3**: 16px / Semibold (600) / Line-height 1.4
- **Body Text**: 14px / Regular (400) / Line-height 1.5
- **Small Body / Label**: 13px / Regular / Semibold
- **Badge & Status**: 11px / Bold / Uppercase / Tracking 0.5px
- **Button Text**: 13px / Semibold / Uppercase

---

## 4. Komponen Antarmuka Utama

### 4.1 Tombol (Button)
- **Primary**: Background `#422AD5`, Teks `#E0E7FF`, Rounded **4px**, Padding **10px 16px**, Teks 13px Semibold UPPERCASE, Hover: `#3824B5`.
- **Secondary**: Background `#F43098`, Teks Putih `#FFFFFF`, Rounded **4px**, Padding **10px 16px**, Teks 13px Semibold UPPERCASE.
- **Outline**: Border 1px `#422AD5`, Teks `#422AD5`, Background transparan, Hover: `#E0E7FF`.
- **Danger**: Background `#DC2626`, Teks Putih (untuk aksi Reject/Cancel — pengecualian fungsional §2.7).
- **Ghost**: Teks `#52525B`, Background transparan, Hover: `#F3F4F6`.
- **Target Sentuh Tablet**: Tinggi minimal 44px – 48px pada antarmuka pengawas.
- *Pemetaan implementasi* (`frontend/src/components/ui/Button.tsx`): varian `primary` → Primary; varian `secondary` → Outline; `danger`/`success` → pengecualian fungsional §2.7.

### 4.2 Form Input & Dropdown
- **Tinggi Elemen**: 40px (Desktop/Mobile), 48px (Tablet Pengawas).
- **Border**: 1px solid `#EEEEEE`, Rounded **4px**.
- **State Focus**: Border `#422AD5`, Focus Ring 2px `#E0E7FF` (tint primary); fokus keyboard global memakai outline `#422AD5`.
- **Placeholder**: Warna `#71717A`.

### 4.3 Kartu & Panel (Card)
- **Warna**: Putih `#FFFFFF`.
- **Border**: 1px solid `#EEEEEE`.
- **Radius**: `8px`.
- **Padding**: 20px.
- **Shadow**: `0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)` (subtle).

### 4.4 Notifikasi Toast (Sonner)
- **Posisi**: Pojok Kanan Atas (`top-right`) di Desktop, Mengambang di Atas Layar (`top-center`) di Mobile.
- **Respon Sukses**: Border kiri hijau, teks tegas, auto-dismiss 4 detik.
- **Respon Error**: Border kiri merah, rincian pesan kesalahan jelas.

### 4.5 Badge Status & Label
- **Radius**: 6px, **Padding**: 4px 8px, **Teks**: 11px Bold UPPERCASE (tracking 0.5px).
- **Pasangan warna (background / teks)** — sama persis dengan tabel §2.5:
  - Success: `#DCFCE7` / `#166534`
  - Warning: `#FEF3C7` / `#92400E`
  - Error: `#FEE2E2` / `#991B1B`
  - Info: `#DBEAFE` / `#1E40AF`
  - Neutral: `#F3F4F6` / `#6B7280`

---

## 5. Aturan Responsif & Ergonomi Mobile (Mobilitas Tinggi di Lapangan)

### 5.1 Breakpoints Standar Tailwind CSS
- **Mobile Smartphone**: `< 768px` (Layar Vendor/Mitra di jalan & Pengawas pos bergerak)
- **Tablet / Kiosk**: `768px – 1023px` (Layar tablet gerbang pengawas)
- **Desktop / Laptop**: `>= 1024px` (Layar THC Admin di kantor)

### 5.2 Prinsip Ramah Jempol (Thumb-Zone Friendly)
1. **Target Sentuh Minimum (Touch Targets)**:
   - Seluruh tombol utama dan input di mobile wajib memiliki tinggi minimal **44px hingga 48px** (khusus tombol check-in pengawas: **50px**).
2. **Transformasi Tabel Menjadi Kartu (Card Stack)**:
   - Pada layar mobile (< 768px), tabel data dilarang menggunakan horizontal scroll yang menyulitkan.
   - Tabel otomatis bertransformasi menjadi **tumpukan kartu vertikal (card stack)** mandiri yang memuat nomor Visit ID, status badge, data Vendor/Mitra, dan tombol aksi langsung.
3. **Sticky Action Bar di Bawah Layar (Bottom Bar)**:
   - Tombol pengiriman form (*SCR-03*) dan tombol aksi ditempatkan menempel di bagian bawah layar (*sticky bottom*) agar dapat ditekan dengan satu jempol tanpa harus scroll ke ujung bawah.
4. **Prioritas QR Code di Layar Tamu (SCR-04 Mobile)**:
   - Saat tamu tiba di gerbang dan membuka HP, kartu QR Code wajib berada di **posisi paling atas (above-the-fold)** dengan kontras maksimal agar langsung bisa dipindai oleh scanner pengawas.

---

## 6. Standarisasi Base Layout & App Shell Berbasis RBAC

Untuk memastikan konsistensi antarmuka (*UI consistency*) di seluruh layar, setiap peran pengguna memiliki arsitektur App Shell (Sidebar, Topbar, & Mobile Navigation) yang terstandarisasi:

- **Sumber kebenaran label menu**: `frontend/src/lib/nav/labels.ts` (`NAV_LABELS`, dipakai SHELL-01 & SHELL-02 agar tujuan yang sama selalu bernama sama); SHELL-04 memakai `VENDOR_NAV` di `frontend/src/components/layouts/VendorMobileShell.tsx`. Label di bawah wajib sama persis dengan implementasi.

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. SUPERADMIN SHELL: Dark Sidebar (Global) + Topbar Switcher Cabang   │
│ 2. ADMIN CABANG SHELL: Clean White Sidebar + Locked Branch Badge       │
│ 3. SECURITY SHELL: Kiosk Topbar (No Sidebar) + Live Digital Clock     │
│ 4. VENDOR/MITRA SHELL: Minimal Topbar + Thumb Bottom Navigation        │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Superadmin Base Layout (Kantor Pusat)
- **Karakter Visual**: Berwibawa, komprehensif, multi-cabang.
- **Desktop (>= 1024px)**:
  - **Sidebar Kiri (Lebar 260px, Dark Neutral `#09090B`, Teks Putih/Abu)**:
    - Header: Logo THC (ungu-biru) + Teks "THC VMS PUSAT".
    - Menu Navigasi (sama persis dengan `NAV_LABELS`):
      1. `📊 Dashboard` (Semua kunjungan & analitik lintas cabang)
      2. `⏳ Antrean Approval` (Badge counter request pending seluruh cabang)
      3. `📍 Fasilitas` (Daftar Cabang, POP, dan miniPOP)
      4. `🛡️ Pengawas` (Kelola akun pengawas seluruh cabang)
      5. `👥 Users` (Kelola admin cabang & mitra vendor)
    - Footer Sidebar: Badge `📍 KANTOR PUSAT` + Avatar Superadmin + Tombol Logout.
  - **Topbar (Tinggi 64px, Putih, Sticky)**:
    - Dropdown Pemilih Cabang: `[📍 Semua Cabang / POP ▼]` (Bisa filter fokus ke cabang tertentu).
    - Search Bar Global & Lonceng Notifikasi Approval.
- **Mobile (< 768px)**:
  - Topbar: Logo THC + Dropdown Cabang compact + Tombol Hamburger Drawer.
  - Bottom Navigation Bar (4 Tab): `[Dashboard]`, `[Approval]`, `[Fasilitas]`, `[Pengawas]`.

---

### 6.2 Admin Cabang Base Layout (Kantor Cabang / POP)
- **Karakter Visual**: Fungsional, terisolasi khusus cabangnya, minim distraksi menu pusat.
- **Desktop (>= 1024px)**:
  - **Sidebar Kiri (Lebar 250px, Putih `#FFFFFF`, Border-Right 1px solid `#EEEEEE`)**:
    - Header: Logo THC (ungu-biru) + Label Cabang (contoh: *"THC Cabang Surabaya"*).
    - Menu Navigasi (sama persis dengan `NAV_LABELS`; desktop 5 item, mobile 4 tab tanpa `Buat Kunjungan Baru`):
      1. `📊 Dashboard` (Monitoring kunjungan khusus cabangnya)
      2. `⏳ Antrean Approval` (Badge counter pending cabangnya, warna brand `#422AD5`)
      3. `🚪 Pos Check-in Gerbang` (Pintas ke SCR-05 jika admin bertindak sebagai checker)
      4. `🛡️ Pengawas` (Panel kelola pengawas cabangnya)
      5. `➕ Buat Kunjungan Baru` (Pintas ke SCR-03; hanya desktop)
    - Footer Sidebar: Label Lokasi Terkunci: `📍 Terkunci: Cabang Surabaya` + Avatar Admin + Logout.
  - **Topbar (Tinggi 64px, Putih, Sticky)**:
    - Badge Statis Terkunci: `📍 Kantor Cabang Surabaya` (Disabled / Non-clickable).
    - Tombol Aksi Cepat: `[+ Tambah Pengawas]` & `[+ Buat Kunjungan]`.
    - Avatar Admin Cabang & Lonceng Notifikasi.
- **Mobile (< 768px)**:
  - Topbar: Logo THC + Badge `📍 Surabaya` + Avatar Admin.
  - Bottom Navigation Bar (4 Tab): `[Dashboard]`, `[Approval]`, `[Check-in]`, `[Pengawas]`.

---

### 6.3 Security Base Layout (Petugas Jaga Gerbang / Kiosk)
- **Karakter Visual**: **Kiosk Mode (Zero Sidebar)**. Didesain tanpa sidebar menu bertingkat agar petugas pos fokus 100% pada verifikasi tamu dan tidak tersesat atau salah klik.
- **Tablet Landscape & Desktop**:
  - **Topbar Kiosk Penuh (Tinggi 70px, Background `#18181B` Gelap Industrial, Teks Putih)**:
    - Kiri: Logo THC + Teks Tegas *"GATE ACCESS CONTROL"* + Badge Lokasi `📍 Pos Gerbang Cabang Surabaya`.
    - Tengah: **Jam Digital Live Real-Time** format detik (`14:30:15 WIB`) + Counter Tamu Aktif (Badge Hijau: `🟢 12 Tamu di Lokasi`).
    - Kanan: Nama Petugas Jaga ("Budi S. - Security Shift Pagi") + Tombol Outline `[Ganti Shift / Logout]` (warna brand `#422AD5`).
  - **Navigasi Sub-Bar (Tab Sentuh Besar Tinggi 52px)**:
    - `[🕒 1. Akan Hadir Hari Ini (8)]` | `[🟢 2. Sedang di Lokasi (12)]` | `[✅ 3. Selesai Hari Ini (15)]`.
- **Mobile (< 768px - Pengawas Bergerak / Patroli)**:
  - Topbar Ringkas: Logo THC + Nama Pos + Jam Digital.
  - Bottom Navigation Bar (3 Tab Sentuh 52px): `[Akan Hadir]`, `[Di Lokasi]`, `[Selesai]`.

---

### 6.4 Customer / Vendor/Mitra Base Layout (Teknisi Eksternal)
- **Karakter Visual**: Bersih, modern, **Mobile-First App Shell** (karena teknisi membukanya dari smartphone di lokasi kerja).
- **Layout Mobile-First (< 768px)**:
  - **Topbar Minimalis (Tinggi 56px, Putih)**:
    - Kiri: Logo THC (ungu-biru) + Teks *"Visitor Portal"*.
    - Kanan: Label Profil Singkat (`👤 PT Fiber Maju`) + Icon Logout.
  - **Bottom Navigation Bar Menempel (Tinggi 64px, Putih, Border-Top, Shadow-lg)**:
    - Tab 1: `🏠 Kunjungan Saya` (Daftar seluruh riwayat pengajuan & status)
    - Tab 2: `➕ Ajukan` (**Tombol Menonjol Bulat Ungu-Biru `#422AD5` di Tengah**; label desktop: `Ajukan Kunjungan Baru`)
    - Tab 3: `📱 Tiket QR` (Akses langsung 1-klik ke QR Code SCR-04 jika ada kunjungan approved hari ini)
- **Desktop (>= 1024px)**:
  - Menggunakan Topbar Navbar Horizontal standar tanpa sidebar, dengan menu tab `[Kunjungan Saya]`, `[+ Ajukan Kunjungan Baru]`, dan `[Tiket QR]`.
