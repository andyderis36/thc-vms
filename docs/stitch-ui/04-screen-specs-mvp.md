# Spesifikasi Layar MVP (SCR-01 s/d SCR-05) – THC VMS (ISP Edition)

Dokumen ini menjelaskan rancangan tata letak (*layout*), komponen, validasi, dan interaksi untuk **5 Layar Inti MVP** dalam operasional Internet Service Provider (ISP) THC.

---

## SCR-01: Login Terpadu

- **Tujuan**: Autentikasi seluruh pengguna (Superadmin Pusat, Admin Cabang/POP, Petugas Jaga/Security, PIC Vendor/Teknisi).
- **Tata Letak**:
  - Desktop: Split 2 kolom. Kiri (60%) visual jaringan fiber optik & fasilitas POP THC. Kanan (40%) form login terpusat.
  - Mobile: 1 kolom kartu terpusat.
- **Elemen UI**:
  - Logo THC & judul *"Visitor Management System"*.
  - Input Email & Input Password.
  - Tombol Utama: *"Masuk ke Sistem"*.
  - **Demo Role Quick Switcher** (Pilihan cepat 1-klik untuk akun demo):
    - `Superadmin (Kantor Pusat)`
    - `Admin Cabang (Surabaya)`
    - `Security (Cabang Surabaya)`
    - `PIC Teknisi (PT Fiber Maju)`
- **Validasi**: Format email valid, password min. 6 karakter.
- **Interaksi**: Submit berhasil mengarahkan ke SCR-02 (Superadmin/Admin/PIC) atau SCR-05 (Security).

---

## SCR-02: Dashboard Kunjungan & Antrean

- **Tujuan**: Monitoring status permohonan akses ke Kantor Cabang / POP / miniPOP, filter data terisolasi per cabang, eksekusi persetujuan oleh Admin, dan registrasi security cabang.
- **Tata Letak & Adaptasi RBAC**:
  - **Header Navbar Terpadu**:
    - Logo THC & menu navigasi `[Dashboard Kunjungan]`.
    - **Indikator Konteks Cabang**:
      - *Superadmin*: Badge `📍 Kantor Pusat THC` + dropdown filter `[Semua Cabang / POP ▼]` + tombol `[Kelola Satpam Cabang]`.
      - *Admin Cabang*: Badge terkunci `📍 Kantor Cabang Surabaya` (read-only, tanpa dropdown) + tombol `[+ Satpam Cabang]`.
      - *PIC Vendor*: Label profil `👤 PT Fiber Maju (PIC Teknisi)`.
    - Tombol *Logout*.
  - **Baris Metrik (4 Kartu Ringkas)**: Total Kunjungan Cabang, Menunggu Approval, Sedang di Lokasi/POP (*visiting*), Selesai.
  - **Filter Bar**:
    - Filter Fasilitas: Aktif untuk Superadmin; Terkunci/Disabled untuk Admin Cabang; Sembunyi untuk PIC.
    - Dropdown Status Kunjungan, Search Box, dan Tombol Primer: *"+ Buat Kunjungan Baru"*.
  - **Tab Navigasi Antrean**:
    - Tab 1: `Semua Kunjungan`
    - Tab 2: `Menunggu Approval` *(Menampilkan badge jumlah request pending)*
    - Tab 3: `Sedang di Lokasi (Visiting)` *(Memantau teknisi yang sedang bekerja di fasilitas saat ini)*
    - Tab 4: `Selesai`
  - **Tabel Data Kunjungan (Desktop)**:
    - Kolom: Visit ID, PIC/Teknisi & Vendor, Fasilitas Tujuan (Cabang/POP/miniPOP), Keperluan, Jadwal, Status Badge, Aksi Cepat.
    - Pada tab 'Menunggu Approval':
      - **Superadmin & Admin Cabang Terkait**: Menampilkan tombol aksi langsung **Approve** (hijau) & **Reject** (merah).
      - **PIC**: Tombol Approve & Reject disembunyikan total (PIC hanya bisa Reschedule / Cancel).
  - **Adaptasi Mobile (< 768px)**:
    - Tabel bertransformasi menjadi **Tumpukan Kartu Kunjungan (Card Stack)** vertikal mandiri (tanpa horizontal scroll).
    - Grid metrik menjadi 2x2.
    - Tombol "+ Buat Kunjungan" menjadi floating action button (FAB) atau sticky bar bawah.
- **Interaksi & Modal**:
  - Klik baris kunjungan membuka **SCR-04: Detail & QR Kunjungan**.
  - Klik Approve memunculkan modal konfirmasi persetujuan.
  - Klik Reject memunculkan modal dengan textarea wajib isi alasan penolakan.
  - **Modal Registrasi & Kelola Satpam Cabang**:
    - Dibuka dari tombol `[Kelola Satpam Cabang]` atau `[+ Satpam Cabang]`.
    - Form Pendaftaran Satpam: Nama Lengkap, Email, No. Telp, Password Awal, dan Cabang Penugasan (read-only sesuai cabang untuk Admin Cabang; dropdown untuk Superadmin).
    - Tabel Satpam Aktif di Cabang: Nama, Email, Status Badge (Aktif / Nonaktif), dan Tombol Nonaktifkan/Aktifkan.
    - Aturan Validasi: Admin cabang tidak bisa menambahkan satpam untuk cabang lain dan tidak bisa mengedit akun role lain.

---

## SCR-03: Form Pengajuan Kunjungan

- **Tujuan**: PIC Teknisi atau THC Admin mengajukan permohonan akses pekerjaan ke Cabang / POP / miniPOP beserta lampiran surat tugas resmi.
- **Tata Letak**:
  - Header: Tombol kembali ke Dashboard & Judul Halaman: *"Pengajuan Akses Fasilitas Jaringan THC"*.
  - Panel Formulir Terstruktur:
    1. **Fasilitas & Keperluan**: Dropdown Pemilihan Fasilitas (Cabang, POP, miniPOP) & Pilihan Keperluan (Troubleshoot, Maintenance, Splicing Fiber, Survey).
    2. **Jadwal Kunjungan**: Date-time picker Waktu Mulai & Waktu Selesai, serta toggle switch *"Pekerjaan Multi-Hari"*.
    3. **Daftar Tim Teknisi (Dinamis)**:
       - Tabel baris teknisi: Nama Lengkap, Nomor KTP/SIM, Nomor HP, opsional upload foto KTP.
       - Tombol: *"+ Tambah Anggota Teknisi"* (Maksimal 10 orang).
    4. **Dokumen Surat Tugas / SPK Vendor (Object Storage MinIO/S3)**:
       - Drag-and-drop / file selector box: *"Unggah Surat Tugas / Surat Perintah Kerja (PDF, JPG, PNG - Maks 5MB)"*.
       - Indikator progres upload dan nama file terlampir.
    5. **Catatan Tambahan**: Textarea untuk rincian pekerjaan atau alat kerja yang dibawa (Splicer, OTDR, genset portable).
    6. **Persetujuan SOP Keselamatan**:
       - Checkbox wajib: *"Saya menyatakan seluruh data teknisi akurat dan menyetujui seluruh Standar Operasional Prosedur (SOP) dan keselamatan kerja fasilitas jaringan THC."*
  - Tombol Aksi Bawah: Tombol Primer *"Kirim Permohonan Kunjungan"*.
  - **Adaptasi Mobile (< 768px)**:
    - Formulir disusun 1 kolom vertikal ramah jempol dengan input minimal tinggi 44px.
    - Upload file mendukung pemilihan langsung dari kamera atau file manager ponsel teknisi.
    - Daftar teknisi berupa kartu ringkas per anggota.
    - Tombol submit form menempel di bagian bawah layar (**sticky bottom bar**).
- **Validasi**:
  - Tanggal mulai tidak boleh di masa lalu.
  - Minimal 1 orang teknisi terdaftar dengan nomor identitas lengkap.
  - File surat tugas maks 5MB dengan ekstensi valid (.pdf, .jpg, .jpeg, .png).
  - Checkbox SOP keselamatan wajib dicentang.

---

## SCR-04: Detail & QR Kunjungan

- **Tujuan**: Rincian izin akses fasilitas, verifikasi dokumen surat tugas, dan kartu QR Code untuk check-in.
- **Tata Letak**:
  - Kartu Header: Nomor Visit ID (font 24px bold), Status Badge, dan Tombol Aksi (Reschedule / Cancel).
  - Kolom Kiri:
    - Panel Informasi Lengkap: PIC, Vendor, Lokasi Cabang/POP, Keperluan, Rentang Waktu, Catatan Perangkat.
    - **Panel Dokumen Surat Tugas**: Menampilkan nama berkas terlampir dengan tombol *"Lihat Dokumen"* / *"Unduh PDF/Gambar"* (langsung dari MinIO/S3 presigned URL).
    - Tabel Tim Teknisi: Daftar nama dan nomor identitas yang diizinkan masuk.
    - Panel Riwayat Status (Vertical Timeline): Timestamp pengajuan, approval, check-in, check-out.
  - Kolom Kanan:
    - **Kartu QR Code Akses Fasilitas**:
      - Tampil saat status = `approved`.
      - QR Code kontras tinggi dengan teks panduan: *"Tunjukkan QR Code ini kepada petugas jaga / security saat tiba di lokasi."*
      - Tombol *"Tampilkan Layar Penuh"* & Tombol *"Unduh QR"*.
  - **Adaptasi Mobile (< 768px - Teknisi di Depan Pintu POP)**:
    - **Kartu QR Code otomatis diposisikan di PALING ATAS LAYAR (above-the-fold)** tanpa perlu scroll, dengan tombol "Perbesar Fullscreen".
    - Rincian informasi kunjungan, dokumen surat tugas, dan daftar teknisi berada di bawah QR Code.
- **Interaksi**:
  - Tombol Reschedule: Membuka modal input tanggal baru & alasan pergeseran.
  - Tombol Cancel: Membuka modal konfirmasi pembatalan.

---

## SCR-05: Security Gate / Site Check-in (Tablet & Mobile)

- **Tujuan**: Pencatatan masuk/keluar teknisi di pos gerbang kantor cabang atau akses shelter POP/miniPOP secara cepat dan fleksibel oleh **Petugas Security** maupun **Admin Cabang**.
- **Tata Letak (Tablet Landscape & Smartphone Mobile)**:
  - Header: Jam digital live, nama fasilitas cabang/POP lokasi penugasan, dan badge role petugas.
  - **Panel Pemindaian Fleksibel (Triple-Mode Scanner)**:
    - **Tab Switcher Scanner**:
      1. `[📷 Kamera Langsung]`: Viewfinder kamera scanner QR Code responsif dengan tombol balik kamera.
      2. `[🖼️ Upload Gambar dari Galeri]`: Tombol pemilih file gambar (`Pilih Screenshot QR dari Galeri/Chat`). Memindai barcode secara instan dari screenshot chat WhatsApp/Telegram yang dikirimkan tamu saat petugas sedang tidak di meja/pos.
    - Divider *"atau input kode manual"*
    - Input teks pencarian: *"Ketik Visit ID (contoh: VST-2026090001)"* + Tombol Cari (Tinggi tombol min. 48px).
  - Antrean Hari Ini:
    - Tab: `Akan Hadir Hari Ini` | `Sedang di Lokasi (Visiting)` | `Selesai (Completed)`.
    - Kartu Tamu: Visit ID, Nama Teknisi, Vendor, Fasilitas Tujuan, Jadwal Terjadwal, Badge Status.
    - **Validasi Waktu**: Sistem memvalidasi rentang toleransi jadwal (±2 jam). Jika di luar batas, tombol check-in disabled dengan tooltip/peringatan kuning.
    - **Tombol Aksi Sentuh Ekstra Besar (Tinggi 48px - 52px)**:
      - Tombol Hijau lebar penuh *"✓ CHECK-IN MASUK"* (pada tab Akan Hadir).
      - Tombol Merah lebar penuh *"CHECK-OUT KELUAR"* (pada tab Sedang di Lokasi).
- **Interaksi**:
  - Klik Check-in: Sistem memvalidasi, mengupdate status menjadi `visiting`, memunculkan toast sukses hijau, dan memperbarui antrean seketika. **Petugas tetap di SCR-05**.
  - Klik Check-out: Sistem mencatat waktu keluar, mengupdate status menjadi `completed`, dan memunculkan toast konfirmasi.
