# Design System – THC Visitor Management System (VMS)

---

## 1. Identitas Brand & Nilai Visual

- **Nama Aplikasi**: THC Visitor Management System (VMS)
- **Karakter Desain**: Bersih (*clean*), fungsional, industrial, kontras tinggi, modern.
- **Bahasa Antarmuka**: Bahasa Indonesia (Standar Profesional).
- **Target Perangkat**:
  - Desktop: THC Admin & Super Admin (Resolusi >= 1024px)
  - Tablet Landscape: Security Gate (Resolusi 768px – 1024px)
  - Mobile: PIC / Vendor (Resolusi < 768px)

---

## 2. Palet Warna (Tailwind CSS Tokens)

### 2.1 Warna Utama (Brand Primary)
- **Primary Main**: `#DE1B1B` (Merah Khas THC)
- **Primary Dark/Hover**: `#B91616`
- **Primary Surface/Soft**: `#FEE2E2`
- **Text on Primary**: `#FFFFFF`

### 2.2 Warna Netral (Neutrals)
- **Background Halaman**: `#F5F7FA` (Cool grey terang, nyaman di mata)
- **Background Kartu & Panel**: `#FFFFFF`
- **Garis Batas (Border Light)**: `#E5E7EB`
- **Garis Batas Aktif (Border Mid)**: `#D1D5DB`
- **Teks Utama (Text Primary)**: `#1A1A1A`
- **Teks Sekunder (Text Secondary)**: `#6B7280`
- **Teks Muted (Placeholder / Caption)**: `#9CA3AF`

### 2.3 Status Badge Mapping (Siklus Kunjungan)

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
- **Primary**: Background `#DE1B1B`, Teks Putih, Rounded 8px, Hover: `#B91616`.
- **Secondary**: Border 1px `#DE1B1B`, Teks `#DE1B1B`, Background Putih.
- **Danger**: Background `#DC2626`, Teks Putih (untuk aksi Reject/Cancel).
- **Ghost**: Teks `#6B7280`, Background transparan, Hover: `#F3F4F6`.
- **Target Sentuh Tablet**: Tinggi minimal 44px – 48px pada antarmuka satpam.

### 4.2 Form Input & Dropdown
- **Tinggi Elemen**: 40px (Desktop/Mobile), 48px (Tablet Satpam).
- **Border**: 1px solid `#D1D5DB`, Rounded 8px.
- **State Focus**: Border `#DE1B1B`, Outline Ring `#FEE2E2`.
- **Placeholder**: Warna `#9CA3AF`.

### 4.3 Kartu & Panel (Card)
- **Warna**: Putih murni `#FFFFFF`.
- **Radius**: `12px` (rounded-xl).
- **Shadow**: `0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)` (subtle).
- **Padding**: 20px – 24px.

### 4.4 Notifikasi Toast (Sonner)
- **Posisi**: Pojok Kanan Atas (`top-right`) di Desktop, Mengambang di Atas Layar (`top-center`) di Mobile.
- **Respon Sukses**: Border kiri hijau, teks tegas, auto-dismiss 4 detik.
- **Respon Error**: Border kiri merah, rincian pesan kesalahan jelas.

---

## 5. Aturan Responsif & Ergonomi Mobile (Mobilitas Tinggi di Lapangan)

### 5.1 Breakpoints Standar Tailwind CSS
- **Mobile Smartphone**: `< 768px` (Layar PIC di jalan & Satpam pos bergerak)
- **Tablet / Kiosk**: `768px – 1023px` (Layar tablet gerbang satpam)
- **Desktop / Laptop**: `>= 1024px` (Layar THC Admin di kantor)

### 5.2 Prinsip Ramah Jempol (Thumb-Zone Friendly)
1. **Target Sentuh Minimum (Touch Targets)**:
   - Seluruh tombol utama dan input di mobile wajib memiliki tinggi minimal **44px hingga 48px** (khusus tombol check-in satpam: **50px**).
2. **Transformasi Tabel Menjadi Kartu (Card Stack)**:
   - Pada layar mobile (< 768px), tabel data dilarang menggunakan horizontal scroll yang menyulitkan.
   - Tabel otomatis bertransformasi menjadi **tumpukan kartu vertikal (card stack)** mandiri yang memuat nomor Visit ID, status badge, data PIC, dan tombol aksi langsung.
3. **Sticky Action Bar di Bawah Layar (Bottom Bar)**:
   - Tombol pengiriman form (*SCR-03*) dan tombol aksi ditempatkan menempel di bagian bawah layar (*sticky bottom*) agar dapat ditekan dengan satu jempol tanpa harus scroll ke ujung bawah.
4. **Prioritas QR Code di Layar Tamu (SCR-04 Mobile)**:
   - Saat tamu tiba di gerbang dan membuka HP, kartu QR Code wajib berada di **posisi paling atas (above-the-fold)** dengan kontras maksimal agar langsung bisa dipindai oleh scanner satpam.

---

## 6. Standarisasi Base Layout & App Shell Berbasis RBAC

Untuk memastikan konsistensi antarmuka (*UI consistency*) di seluruh layar, setiap peran pengguna memiliki arsitektur App Shell (Sidebar, Topbar, & Mobile Navigation) yang terstandarisasi:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. SUPERADMIN SHELL: Dark Sidebar (Global) + Topbar Switcher Cabang   │
│ 2. ADMIN CABANG SHELL: Clean White Sidebar + Locked Branch Badge       │
│ 3. SECURITY SHELL: Kiosk Topbar (No Sidebar) + Live Digital Clock     │
│ 4. PIC VENDOR SHELL: Minimal Topbar + Thumb Bottom Navigation          │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Superadmin Base Layout (Kantor Pusat)
- **Karakter Visual**: Berwibawa, komprehensif, multi-cabang.
- **Desktop (>= 1024px)**:
  - **Sidebar Kiri (Lebar 260px, Dark Slate `#0F172A`, Teks Putih/Abu)**:
    - Header: Logo THC Merah + Teks "THC VMS PUSAT".
    - Menu Navigasi:
      1. `📊 Dashboard Global` (Semua kunjungan & analitik lintas cabang)
      2. `⏳ Antrean Approval` (Badge counter request pending seluruh cabang)
      3. `📍 Fasilitas & Cabang` (Daftar Cabang, POP, dan miniPOP)
      4. `🛡️ Manajemen Security` (Kelola akun satpam seluruh cabang)
      5. `👥 Manajemen User & Vendor` (Kelola admin cabang & mitra vendor)
    - Footer Sidebar: Badge `📍 KANTOR PUSAT` + Avatar Superadmin + Tombol Logout.
  - **Topbar (Tinggi 64px, Putih, Sticky)**:
    - Dropdown Pemilih Cabang: `[📍 Semua Cabang / POP ▼]` (Bisa filter fokus ke cabang tertentu).
    - Search Bar Global & Lonceng Notifikasi Approval.
- **Mobile (< 768px)**:
  - Topbar: Logo THC + Dropdown Cabang compact + Tombol Hamburger Drawer.
  - Bottom Navigation Bar (4 Tab): `[Dashboard]`, `[Approval]`, `[Fasilitas]`, `[Security]`.

---

### 6.2 Admin Cabang Base Layout (Kantor Cabang / POP)
- **Karakter Visual**: Fungsional, terisolasi khusus cabangnya, minim distraksi menu pusat.
- **Desktop (>= 1024px)**:
  - **Sidebar Kiri (Lebar 250px, Putih `#FFFFFF`, Border-Right 1px solid `#E5E7EB`)**:
    - Header: Logo THC Merah + Label Cabang (contoh: *"THC Cabang Surabaya"*).
    - Menu Navigasi:
      1. `📊 Dashboard Kunjungan` (Monitoring kunjungan khusus cabangnya)
      2. `⏳ Persetujuan Kunjungan` (Badge merah counter pending cabangnya)
      3. `🚪 Pos Check-in Gerbang` (Pintas ke SCR-05 jika admin bertindak sebagai checker)
      4. `👮 Satpam Cabang` (Pintas ke Modal Kelola Satpam cabangnya)
      5. `➕ Buat Kunjungan Baru` (Pintas ke SCR-03)
    - Footer Sidebar: Label Lokasi Terkunci: `📍 Terkunci: Cabang Surabaya` + Avatar Admin + Logout.
  - **Topbar (Tinggi 64px, Putih, Sticky)**:
    - Badge Statis Terkunci: `📍 Kantor Cabang Surabaya` (Disabled / Non-clickable).
    - Tombol Aksi Cepat: `[+ Tambah Satpam]` & `[+ Buat Kunjungan]`.
    - Avatar Admin Cabang & Lonceng Notifikasi.
- **Mobile (< 768px)**:
  - Topbar: Logo THC + Badge `📍 Surabaya` + Avatar Admin.
  - Bottom Navigation Bar (4 Tab): `[Dashboard]`, `[Approval]`, `[Check-in]`, `[Satpam]`.

---

### 6.3 Security Base Layout (Petugas Jaga Gerbang / Kiosk)
- **Karakter Visual**: **Kiosk Mode (Zero Sidebar)**. Didesain tanpa sidebar menu bertingkat agar petugas pos fokus 100% pada verifikasi tamu dan tidak tersesat atau salah klik.
- **Tablet Landscape & Desktop**:
  - **Topbar Kiosk Penuh (Tinggi 70px, Background `#1E293B` Gelap Industrial, Teks Putih)**:
    - Kiri: Logo THC + Teks Tegas *"GATE ACCESS CONTROL"* + Badge Lokasi `📍 Pos Gerbang Cabang Surabaya`.
    - Tengah: **Jam Digital Live Real-Time** format detik (`14:30:15 WIB`) + Counter Tamu Aktif (Badge Hijau: `🟢 12 Tamu di Lokasi`).
    - Kanan: Nama Petugas Jaga ("Budi S. - Security Shift Pagi") + Tombol Merah `[Ganti Shift / Logout]`.
  - **Navigasi Sub-Bar (Tab Sentuh Besar Tinggi 52px)**:
    - `[🕒 1. Akan Hadir Hari Ini (8)]` | `[🟢 2. Sedang di Lokasi (12)]` | `[✅ 3. Selesai Hari Ini (15)]`.
- **Mobile (< 768px - Satpam Bergerak / Patroli)**:
  - Topbar Ringkas: Logo THC + Nama Pos + Jam Digital.
  - Bottom Navigation Bar (3 Tab Sentuh 52px): `[Akan Hadir]`, `[Di Lokasi]`, `[Selesai]`.

---

### 6.4 Customer / PIC Vendor Base Layout (Teknisi Eksternal)
- **Karakter Visual**: Bersih, modern, **Mobile-First App Shell** (karena teknisi membukanya dari smartphone di lokasi kerja).
- **Layout Mobile-First (< 768px)**:
  - **Topbar Minimalis (Tinggi 56px, Putih)**:
    - Kiri: Logo THC Merah + Teks *"Visitor Portal"*.
    - Kanan: Label Profil Singkat (`👤 PT Fiber Maju`) + Icon Logout.
  - **Bottom Navigation Bar Menempel (Tinggi 64px, Putih, Border-Top, Shadow-lg)**:
    - Tab 1: `🏠 Kunjungan Saya` (Daftar seluruh riwayat pengajuan & status)
    - Tab 2: `➕ Ajukan Kunjungan` (**Tombol Menonjol Bulat Merah THC `#DE1B1B` di Tengah**)
    - Tab 3: `📱 Tiket QR Aktif` (Akses langsung 1-klik ke QR Code SCR-04 jika ada kunjungan approved hari ini)
- **Desktop (>= 1024px)**:
  - Menggunakan Topbar Navbar Horizontal standar tanpa sidebar, dengan menu tab `[Kunjungan Saya]`, `[+ Ajukan Kunjungan Baru]`, dan `[Tiket QR]`.
