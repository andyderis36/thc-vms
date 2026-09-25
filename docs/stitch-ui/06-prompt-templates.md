# Master Prompt Templates untuk Google Stitch – THC VMS (5 Screen MVP ISP)

Dokumen ini berisi **5 Master Prompt mandiri (*self-contained*)** yang **100% responsif (Mobile & Desktop)**, disesuaikan khusus untuk proses operasional **Internet Service Provider (ISP) THC**: pemantauan teknisi, vendor, dan tim operasional yang berkunjung ke **Kantor Cabang, POP (Point of Presence), dan miniPOP**.

---

## Panduan Cepat untuk Google Stitch:
1. Buka project Anda di [Google Stitch](https://stitch.withgoogle.com/).
2. Buat screen baru sesuai nama layar (contoh: `BASE-01 Layout Admin` atau `SCR-01 Login`).
3. Salin satu blok kode prompt di bawah, tempel ke Stitch prompt box, lalu tekan **Generate**.

---

## 0. Master Prompt: Base Layout & App Shell Berbasis RBAC (Sidebar & Navbar)

Gunakan prompt di bawah untuk meminta Google Stitch membuatkan template dasar (*Base Layout / App Shell*) yang konsisten sebelum menyusun konten halaman:

### SHELL-01: Base Layout Superadmin (Kantor Pusat)
```text
Buat Base Layout / App Shell antarmuka web modern untuk peran "Superadmin (Kantor Pusat)" pada aplikasi "THC Visitor Management System (VMS) - ISP Network Facilities".

Aturan Desain & Brand:
- Warna Utama: #DE1B1B (merah THC), Sidebar: #0F172A (dark slate berwibawa), Background Konten: #F5F7FA
- Bahasa Antarmuka: Bahasa Indonesia profesional

Komponen Sidebar Kiri (Desktop >= 1024px, lebar 260px, sticky):
- Header Sidebar: Logo THC merah cerah + Teks tebal "THC VMS PUSAT" + Sub-label "Kantor Pusat Jakarta".
- Menu Navigasi (Icon Lucide + Label teks 14px + State hover/active indicator merah #DE1B1B):
  1. [📊 Dashboard Global] (State Aktif: background #1E293B dengan border kiri merah 3px)
  2. [⏳ Antrean Approval] (Dengan badge merah angka counter pending: "8")
  3. [📍 Fasilitas & Cabang] (Daftar Kantor Cabang, POP, dan miniPOP)
  4. [🛡️ Manajemen Security] (Daftar akun satpam seluruh cabang)
  5. [👥 Manajemen User & Vendor] (Admin cabang & mitra teknisi eksternal)
- Footer Sidebar:
  * Kartu info pengguna ringkas: Avatar Superadmin, Nama "Bambang Wijaya", Badge role abu-abu "SUPERADMIN".
  * Tombol Logout merah outline transparan.

Komponen Topbar / Navbar (Desktop, tinggi 64px, background putih #FFFFFF, border-bottom 1px solid #E5E7EB, sticky top):
- Kiri: Search box global ("Cari Visit ID, teknisi, atau fasilitas...") dengan icon pencarian.
- Kanan:
  * Dropdown Pemilih Cabang (Branch Switcher): Pill dropdown "[📍 Semua Cabang / POP ▼]" (opsi: Semua Cabang, KC Surabaya, KC Medan, POP Karet, dll).
  * Lonceng Notifikasi dengan badge titik merah (notifikasi approval baru).
  * Avatar profil dan status online hijau.

Komponen Konten Utama (Main Content Area):
- Breadcrumb navigasi ("Beranda / Dashboard Global").
- Area placeholder kosong bertuliskan "{Konten Halaman Superadmin}".

Adaptasi Mobile (< 768px):
- Topbar: Logo THC + Dropdown Cabang compact + Tombol Hamburger Drawer (membuka sidebar sebagai slide-over sheet).
- Bottom Navigation Bar (4 Tab): [Dashboard], [Approval (8)], [Fasilitas], [User].
```

---

### SHELL-02: Base Layout Admin Cabang (Kantor Cabang / POP)
```text
Buat Base Layout / App Shell antarmuka web fungsional untuk peran "Admin Cabang / POP" pada aplikasi "THC Visitor Management System (VMS) - ISP Network Facilities".

Aturan Desain & Brand:
- Warna Utama: #DE1B1B (merah THC), Sidebar: #FFFFFF (bersih dengan border-right #E5E7EB), Background Konten: #F5F7FA
- Bahasa Antarmuka: Bahasa Indonesia profesional

Komponen Sidebar Kiri (Desktop >= 1024px, lebar 250px, sticky):
- Header Sidebar: Logo THC merah + Teks bold "THC VMS" + Label Cabang: "📍 Cabang Surabaya".
- Menu Navigasi (Icon Lucide + Label 14px, state aktif border-left 3px #DE1B1B & bg #FEE2E2):
  1. [📊 Dashboard Kunjungan] (State Aktif)
  2. [⏳ Persetujuan Kunjungan] (Badge merah counter pending cabangnya: "3")
  3. [🚪 Pos Check-in Gerbang] (Pintas langsung ke layar scan gerbang SCR-05)
  4. [👮 Satpam Cabang] (Pintas kelola akun security cabangnya)
  5. [➕ Buat Kunjungan Baru] (Pintas pengajuan form SCR-03)
- Footer Sidebar:
  * Badge informasi lokasi terkunci: "🔒 Penugasan: KC Surabaya (Read-Only)".
  * Kartu profil: Avatar "Ahmad - Admin Cabang" + Tombol Logout.

Komponen Topbar / Navbar (Desktop, tinggi 64px, background putih #FFFFFF, sticky top):
- Kiri: Badge status lokasi tetap bertuliskan "📍 Kantor Cabang Surabaya (Terkunci)" - TIDAK BISA DIGANTI.
- Kanan:
  * Tombol Aksi Cepat Sekunder: [+ Tambah Satpam Cabang] (membuka modal manajemen satpam).
  * Tombol Aksi Primer: [+ Buat Kunjungan] (bg #DE1B1B).
  * Lonceng Notifikasi & Avatar Admin.

Komponen Konten Utama (Main Content Area):
- Area placeholder bertuliskan "{Konten Halaman Admin Cabang Surabaya}".

Adaptasi Mobile (< 768px):
- Topbar Mobile: Logo THC + Badge "📍 Surabaya" + Avatar Admin.
- Bottom Navigation Bar Menempel (4 Tab): [Dashboard], [Approval (3)], [Check-in], [Satpam].
```

---

### SHELL-03: Base Layout Security Gate (Kiosk Mode - Pos Jaga Gerbang)
```text
Buat Base Layout / App Shell khusus "Security Gate / Kiosk Mode" tanpa sidebar samping yang membingungkan untuk pos jaga gerbang kantor cabang / shelter POP pada "THC Visitor Management System (VMS)".

Aturan Desain & Brand:
- Desain Kiosk: ZERO SIDEBAR MENU (Satpam dilarang terdistraksi menu pengaturan/admin).
- Warna Topbar: #1E293B (Dark Slate Industrial kokoh), Warna Utama Aksi: #DE1B1B, Background: #F5F7FA
- Karakter: Huruf besar, kontras ekstra tinggi, target sentuh minimal tinggi 48px - 52px untuk kenyamanan tablet dan smartphone satpam di lapangan.
- Bahasa Antarmuka: Bahasa Indonesia tegas

Komponen Topbar Kiosk Penuh (Tinggi 70px, Background #1E293B, Teks Putih, Sticky Top):
- Kiri: Logo THC putih + Teks Kapital bold "GATE ACCESS CONTROL" + Badge outline putih "📍 Pos Gerbang Cabang Surabaya".
- Tengah:
  * Jam Digital Live Real-Time (Font monospaced bold 20px dengan detik berkedip: "14:35:22 WIB").
  * Badge Status Tamu Aktif (Background hijau #166534, teks putih bold: "🟢 15 Teknisi On-Site").
- Kanan:
  * Info Petugas: Avatar Satpam, Nama "Budi Santoso (Shift Pagi)".
  * Tombol Merah Outline Tebal: [Ganti Shift / Logout].

Komponen Sub-Bar Navigasi Antrean (Tepat di bawah topbar, tinggi 56px, background putih, shadow-sm):
- 3 Tab Tombol Sentuh Besar (Touch Target 50px):
  1. [🕒 Akan Hadir Hari Ini (8 Tamu)] (State aktif: border-bottom 3px #DE1B1B, font bold)
  2. [🟢 Sedang di Lokasi / Visiting (15 Tamu)]
  3. [✅ Selesai / Completed (24 Tamu)]

Komponen Konten Utama (Main Content Area):
- Area placeholder luas bertuliskan "{Layar Pemindai QR & Daftar Tamu SCR-05}".

Adaptasi Mobile (< 768px - Satpam Bergerak / Patroli):
- Topbar: Logo THC + "Pos Gerbang Surabaya" + Jam Digital ringkas.
- Floating / Sticky Bottom Bar: 3 Tombol Tab sentuh lebar jempol [Akan Hadir], [Di Lokasi], [Selesai].
```

---

### SHELL-04: Base Layout PIC Vendor / Teknisi Eksternal (Mobile-First Portal)
```text
Buat Base Layout / App Shell bergaya modern Mobile-First untuk "Portal Teknisi & Vendor Mitra" pada "THC Visitor Management System (VMS)".

Aturan Desain & Brand:
- Karakter: Mobile-First, bersih, intuitif, tanpa sidebar membingungkan.
- Warna Utama: #DE1B1B (Merah THC), Background: #F5F7FA, Card/Nav: #FFFFFF
- Bahasa Antarmuka: Bahasa Indonesia bersahabat

Tata Letak Mobile-First (< 768px - Tampilan Smartphone Utama Teknisi di Lapangan):
- Topbar Sederhana (Tinggi 56px, background putih, border-bottom 1px solid #E5E7EB, sticky top):
  * Kiri: Logo THC merah + Teks "THC Visitor Portal".
  * Kanan: Badge nama vendor "👤 PT Fiber Maju" + Tombol logout kecil.
- Konten Utama (Main Container):
  * Padding 16px dengan area placeholder bertuliskan "{Konten Kunjungan Teknisi}".
- Bottom Navigation Bar Menempel (Tinggi 64px, background putih, border-top 1px solid #E5E7EB, shadow-lg, sticky bottom):
  * Tab 1: [🏠 Kunjungan Saya] (Daftar tiket riwayat pengajuan & status)
  * Tab 2: [➕ Ajukan Akses] (TOMBOL BULAT MENONJOL KE ATAS: Lingkaran Merah #DE1B1B dengan icon plus putih di tengah navbar untuk mengajukan kunjungan baru SCR-03)
  * Tab 3: [📱 Tiket QR Aktif] (Akses 1-sentuh langsung ke QR Code SCR-04 jika izin sudah disetujui hari ini)

Tata Letak Desktop (>= 1024px):
- Topbar Horizontal penuh dengan menu: [Logo THC] [Kunjungan Saya] [+ Ajukan Kunjungan Baru] [Tiket QR Akses] --- [Profil PT Fiber Maju] [Logout].
```

---

## 1. Master Prompt: 5 Layar Inti MVP (SCR-01 s/d SCR-05)

### SCR-01: Login Terpadu
```text
Buat halaman login modern, aman, dan fully mobile-responsive untuk "THC Visitor Management System (VMS) - ISP Network Facilities".

Aturan Desain & Brand:
- Nama Aplikasi: "THC Visitor Management System (VMS)"
- Warna Utama: #DE1B1B (merah THC), Hover: #B91616, Soft: #FEE2E2
- Background Halaman: #F5F7FA (cool grey bersih), Kartu/Panel: #FFFFFF murni
- Font Family: Inter, semibold untuk heading, regular 14px untuk body
- Tombol: bg #DE1B1B, teks putih, border-radius 8px, semibold, uppercase, tinggi min 44px
- Bahasa Antarmuka: Bahasa Indonesia profesional

Tata Letak Desktop (>= 1024px):
- Split 2 kolom:
  * Sisi Kiri (60%): Gradient gelap ke merah THC (#DE1B1B) dengan ilustrasi jaringan fiber optic & server POP ISP, logo THC putih, dan tagline "Sistem Pengelolaan Kunjungan Kantor Cabang & POP/miniPOP THC".
  * Sisi Kanan (40%): Card putih terpusat (max-width 420px) berisi Logo THC, Heading "Selamat Datang", Input Email, Input Password, Tombol "Masuk ke Sistem", dan Quick Switcher Akun Demo (4 Role): [Superadmin Pusat], [Admin Cabang Sby], [Security Sby], [PIC Vendor] (Seluruh akun demo menggunakan password seragam: Password123!).

Tata Letak Mobile (< 768px - Layar HP):
- Tampilan 1 kolom bersih terpusat (mobile-first):
  * Header atas: Logo THC merah + Judul "THC VMS" ringkas.
  * Card form login putih (border-radius 16px, padding 20px, shadow-sm):
    - Input Email (tinggi 44px, keyboard type email).
    - Input Password (tinggi 44px).
    - Tombol Primer Lebar Penuh: "Masuk ke Sistem" (bg #DE1B1B, tinggi 48px, thumb-friendly).
    - Quick Switcher Akun Demo: 4 tombol pill sentuh horizontal [Superadmin], [Admin Cabang], [Security], [PIC Vendor] (Otomatis mengisi email role terkait dan password "Password123!").
  * Footer ringkas di bawah.

Device Target: Mobile-First Responsive (Smartphone & Desktop)
```

---

### SCR-02: Dashboard Kunjungan & Antrean Approval
```text
Buat halaman dashboard utama dan antrean persetujuan kunjungan teknisi/vendor ke fasilitas POP ISP untuk "THC Visitor Management System (VMS)" dengan dukungan Multi-Branch RBAC.

Aturan Desain & Brand:
- Warna Utama: #DE1B1B (merah THC), Background: #F5F7FA, Panel/Card: #FFFFFF
- Status Badge: border-radius 6px, padding 4px 8px, teks 11px uppercase bold:
  * requested / visiting: bg #DBEAFE, text #1E40AF (biru)
  * approved / completed: bg #DCFCE7, text #166534 (hijau)
  * rejected / not_visit: bg #FEE2E2, text #991B1B (merah)
  * cancelled: bg #F3F4F6, text #6B7280 (abu)
  * rescheduled: bg #FEF3C7, text #92400E (kuning)
- Bahasa Antarmuka: Bahasa Indonesia

Tata Letak Desktop (>= 1024px):
- Header Navbar Terpadu (tinggi 64px, putih, border-bottom 1px solid #E5E7EB, sticky top):
  * Kiri: Logo THC (merah #DE1B1B) + Teks bold "THC Visitor Management".
  * Tengah: Menu Tab [Dashboard Kunjungan (Aktif)], [+ Buat Kunjungan].
  * Kanan: 
    - Indikator Cabang:
      * Jika Superadmin: Dropdown [📍 Semua Cabang / POP ▼] + Tombol Outline [Kelola Satpam Cabang].
      * Jika Admin Cabang: Badge Terkunci [📍 Kantor Cabang Surabaya] + Tombol [ + Satpam Cabang].
      * Jika PIC Vendor: Badge [👤 PT Fiber Maju (PIC)].
    - Bell Notifikasi & Avatar Profil ("Ahmad - THC Admin").
- Konten Utama: 
  * Baris Metrik (4 Kartu Ringkas): Total Kunjungan (142), Menunggu Approval (8), Sedang di Lokasi/POP (15), Selesai (119).
  * Filter Bar: Dropdown Tipe Fasilitas (aktif untuk Superadmin, terkunci untuk Admin cabang), Dropdown Status, Search box ("Cari Visit ID, Nama Teknisi, atau Lokasi POP...").
  * Tab Antrean:
    [Semua Kunjungan] | [Menunggu Approval (8)] | [Sedang di Lokasi (15)] | [Selesai]
  * Tabel Data Modern:
    - Kolom: Visit ID, PIC/Vendor Teknisi, Fasilitas (Cabang/POP/miniPOP), Tujuan (Splicing/Maintenance/Troubleshoot), Tanggal & Jam, Status Badge, Aksi Cepat.
    - Pada tab 'Menunggu Approval':
      * Untuk Admin Cabang & Superadmin: Tampilkan tombol aksi cepat: Tombol "Approve" (hijau) dan Tombol "Reject" (merah outline).
      * Untuk PIC Vendor: Tombol Approve/Reject disembunyikan.
- Modal Kelola Satpam Cabang (Overlay):
  * Header: "Manajemen Akun Security Cabang".
  * Sub-header: Menampilkan lokasi cabang yang dikelola.
  * Form Registrasi Cepat: Input Nama Satpam, Input Email, Input No Telp, Input Password Awal, Tombol "Simpan Akun Satpam".
  * Tabel Daftar Satpam Cabang: Nama, Email, Status Badge [Aktif / Nonaktif], Tombol Aksi [Nonaktifkan / Aktifkan].

Tata Letak Mobile (< 768px - Layar HP):
- Header Mobile Compact: Logo THC, Badge Cabang [📍 Surabaya], dan Avatar Profil ringkas.
- Tombol Baris Cepat: Tombol Merah "+ Buat Kunjungan" & Tombol Outline "+ Akun Satpam" (untuk Admin).
- Metrik Ringkas: Grid 2x2 kartu angka (Total, Pending, Di POP, Selesai).
- Tab Antrean Mobile: Horizontal scrollable pills: [Semua] | [Menunggu Approval (8)] | [Di Lokasi (15)] | [Selesai].
- **Tumpukan Kartu Kunjungan (Card Stack)**:
  * Di HP, tabel otomatis menjadi kartu mandiri:
    - Baris Atas: Visit ID + Status Badge di kanan.
    - Baris Tengah: Nama Teknisi / Vendor, Fasilitas Tujuan (contoh: "miniPOP Cibubur" / "POP Medan"), Tanggal/Jam.
    - Baris Bawah:
      * Jika Admin di tab Pending: Tombol Hijau "Approve" dan Tombol Merah "Reject" (lebar 50% masing-masing, tinggi 40px).
      * Jika PIC Teknisi: Tombol Outline "Lihat Detail & QR".

Device Target: Mobile-First & Desktop Responsive
```

---

### SCR-03: Form Pengajuan Kunjungan Terpadu
```text
Buat halaman formulir pengajuan kunjungan ke Kantor Cabang / POP / miniPOP THC untuk "THC Visitor Management System (VMS)".

Aturan Desain & Brand:
- Warna Utama: #DE1B1B (merah THC), Background: #F5F7FA, Card: #FFFFFF, Border: #D1D5DB
- Input & Tombol: Touch target minimal tinggi 44px - 48px untuk kenyamanan jempol di layar HP
- Bahasa Antarmuka: Bahasa Indonesia profesional

Tata Letak Desktop (>= 1024px):
- Header Navbar Terpadu, Container terpusat max-width 900px, 4 section kartu form terstruktur, tombol submit di bawah.

Tata Letak Mobile (< 768px - Teknisi Mengajukan dari HP di Lapangan):
- Header Mobile: Tombol back "← Kembali" + Judul ringkas: "Pengajuan Kunjungan Fasilitas".
- Form disusun 1 kolom vertikal mengalir (padding 16px):
  * Section 1: Fasilitas & Keperluan:
    - Dropdown Fasilitas Tujuan: "Pilih Lokasi (Kantor Cabang / POP / miniPOP, contoh: miniPOP Cibubur)".
    - Pilihan Tujuan (Chip/Badge sentuh): [✓ Troubleshoot] [✓ Maintenance] [✓ Splicing Fiber] [Survey].
  * Section 2: Jadwal Kunjungan:
    - Input Date-Time Mulai & Selesai.
    - Toggle Switch: "Pekerjaan Multi-Hari".
  * Section 3: Daftar Anggota Tim Teknisi:
    - Setiap teknisi ditampilkan dalam kartu border tipis (`Teknisi #1`, `Teknisi #2`):
      Input Nama Lengkap, Input No. KTP/SIM, Input No. HP (keyboard type numeric).
    - Tombol Lebar: "+ Tambah Anggota Teknisi" (Maks. 10 orang).
  * Section 4: Lampiran Dokumen Surat Tugas / SPK (Object Storage):
    - Dropzone box (border dashed #D1D5DB, rounded-lg, padding 16px, text-center):
      Icon upload dokumen + teks "Unggah Surat Tugas / Surat Perintah Kerja (SPK) Vendor" + Subteks "Format PDF, PNG, JPG (Maks. 5MB)" + Tombol "Pilih Berkas dari HP/Komputer".
  * Section 5: Catatan Pekerjaan & Persetujuan Safety:
    - Textarea Catatan Tambahan: Daftar perangkat/alat kerja yang dibawa (OTDR, Splicer, SFP).
    - Kotak Info Kuning: Persetujuan Aturan Keselamatan Fasilitas Jaringan THC.
    - Checkbox Wajib (24x24px): "Saya menyetujui seluruh Standar Operasional Prosedur (SOP) dan keselamatan kerja fasilitas jaringan THC."
- **Tombol Sticky Bottom Bar**:
  * Tombol Primer "Kirim Permohonan Kunjungan" menempel di bagian bawah layar HP (sticky bottom, tinggi 48px, lebar penuh).

Device Target: Mobile-First Responsive (Smartphone & Desktop)
```

---

### SCR-04: Detail & QR Kunjungan (Tampilan Teknisi di HP)
```text
Buat halaman detail kunjungan dan kartu QR Code akses fasilitas yang dioptimalkan untuk ditunjukkan teknisi lewat layar smartphone pada "THC Visitor Management System (VMS)".

Aturan Desain & Brand:
- Warna Utama: #DE1B1B (merah THC), Background: #F5F7FA, Card: #FFFFFF
- Status Badge Hijau: "APPROVED" (bg #DCFCE7, text #166534)
- Bahasa Antarmuka: Bahasa Indonesia profesional

Tata Letak Mobile-First (< 768px - Teknisi Berdiri di Depan Petugas / Pintu POP):
- **PRIORITAS UTAMA DI PALING ATAS LAYAR: KARTU QR CODE AKSES**:
  * Saat teknisi tiba di lokasi, QR Code HARUS berada di posisi paling atas tanpa perlu scroll!
  * Kartu QR Code Putih Bersih (border 2px solid #DE1B1B, shadow-md, text-center):
    - Status Badge Hijau: "AKSES DISETUJUI (APPROVED)".
    - Nomor Visit ID tebal: "VST-9548545669".
    - Gambar QR Code Kontras Tinggi Besar (220x220px) di tengah layar.
    - Teks petunjuk jelas: "Tunjukkan QR Code ini kepada petugas jaga / security saat masuk ke lokasi POP."
    - Tombol Sentuh: "Perbesar Layar Penuh (Fullscreen)" dengan brightness maksimal.
- Tombol Aksi Cepat Mobile (di bawah QR):
  * Tombol Outline: "Reschedule Jadwal" dan Tombol Ghost: "Batalkan Kunjungan".
- Informasi Kunjungan (Card Stack di bawah):
  * Card Ringkas: Lokasi Fasilitas ("miniPOP Cibubur - Shelter A"), Tanggal/Jam, Keperluan ("Splicing Kabel Fiber Cut").
  * Card Lampiran Dokumen: Icon PDF merah + Teks "Surat_Tugas_PT_Fiber_Maju.pdf (420 KB)" + Tombol Outline "Lihat Dokumen / Unduh".
  * Card Daftar Anggota Tim: List nama teknisi beserta nomor KTP terverifikasi.
  * Card Status Timeline: Timeline vertikal (Diajukan -> Disetujui -> Sedang di Lokasi -> Selesai).

Tata Letak Desktop (>= 1024px):
- Header Navbar Terpadu, Breadcrumb, Grid 2 Kolom (Kiri: Detail Informasi & Daftar Tamu 65%, Kanan: Kartu QR Code Sticky 35%).

Device Target: Mobile-First (Dioptimasi untuk Tampilan Layar HP Teknisi) & Desktop
```

---

### SCR-05: Security Gate / Site Check-in (Tablet & Mobile)
```text
Buat antarmuka pos jaga / check-in fasilitas (Security Gate / Site Access) yang sangat ramah sentuhan, responsif untuk Tablet maupun Smartphone pada "THC Visitor Management System (VMS)".

Aturan Desain & Brand:
- Warna Utama: #DE1B1B, Background: #F5F7FA, Card: #FFFFFF
- Target Sentuh Sentral: Seluruh tombol aksi memiliki tinggi minimal 48px - 52px dengan font tebal dan kontras tinggi.
- Bahasa Antarmuka: Bahasa Indonesia

Tata Letak Tablet Landscape & Desktop:
- Top Bar: Jam digital live, Nama Lokasi Fasilitas ("Pos Jaga - Kantor Cabang Medan / POP Karet"), dan Badge Role ("Petugas Security / Admin Cabang").
- Split 2 Kolom:
  * Sisi Kiri (42%):
    - Tab Switcher Scanner: [📷 Kamera Live] | [🖼️ Upload Gambar QR dari Galeri]
    - Jika Tab Kamera aktif: Viewfinder scanner responsif (border merah #DE1B1B).
    - Jika Tab Galeri aktif: Box upload/drag-and-drop file gambar screenshot QR dari chat tamu ("Pilih File Gambar QR dari Galeri").
    - Divider "atau"
    - Input Pencarian Manual besar: "Input Visit ID: VST-XXXXXXXXXX" + Tombol "Cari Data".
  * Sisi Kanan (58%): Tab Antrean Tamu (Akan Hadir Hari Ini, Sedang di Lokasi, Selesai) dengan tombol sentuh besar "CHECK-IN MASUK" dan "CHECK-OUT KELUAR".

Tata Letak Mobile Smartphone (< 768px - Petugas / Security / Admin di Lapangan):
- Top Bar Mobile: Nama Lokasi Fasilitas Cabang / POP ("📍 Kantor Cabang Surabaya").
- Mode Pemindaian Serbaguna (Triple-Mode):
  * Tab Pill Pilihan Mode: [📷 Kamera] | [🖼️ Dari Galeri/Chat].
  * Panel Kamera: Viewfinder scanner QR Code tinggi 180px dengan tombol ganti kamera.
  * Panel Galeri: Tombol sentuh lebar "Pilih Gambar QR dari File / WhatsApp" untuk verifikasi remote saat petugas sedang patroli/di luar pos.
  * Input Pencarian Manual besar (tinggi 48px): "Input Visit ID (VST-XXXXXXXXXX)..." + Tombol "Cari".
- Tab Status Antrean Mobile (Swipeable Pills):
  [Akan Hadir Hari Ini (12)] | [Sedang di Lokasi (5)] | [Selesai (8)]
- Kartu Tamu Mobile Berukuran Jempol (Card Stack):
  * Kartu 1: VST-9548545669 - Tim Fiber Optik (PT Solusi Jaringan) - miniPOP Cibubur - 3 Teknisi.
  * Teks info jadwal: "Jadwal: 09:00 - 17:00 WIB (Toleransi aktif)".
  * **Tombol Hijau Ekstra Besar Lebar Penuh**: "✓ CHECK-IN MASUK" (tinggi 50px, background #16A34A, teks putih tebal).
  * Kartu 2 (Pada tab Sedang di Lokasi): **Tombol Merah Lebar Penuh**: "CHECK-OUT KELUAR" (tinggi 50px, background #DC2626).
- Feedback: Notifikasi toast hijau melayang di atas layar saat check-in sukses tanpa me-refresh atau memindahkan layar.

Device Target: Tablet & Smartphone Mobile Responsive
```
