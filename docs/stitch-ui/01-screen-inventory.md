# Screen Inventory – THC Visitor Management System (VMS)

Dokumentasi ini merampingkan antarmuka menjadi **5 Layar Inti MVP** yang disesuaikan secara presisi dengan kebutuhan operasional **Internet Service Provider (ISP) THC**: perizinan dan pencatatan akses teknisi/vendor ke **Kantor Cabang, POP (Point of Presence), dan miniPOP**.

---

## 1. Layar Inti MVP (Hanya 5 Screen Saja)

| No | Kode Layar | Nama Layar | Target Pengguna | Prioritas | Keterangan |
|---:|---|---|---|---|---|
| 1 | **SCR-01** | Login Terpadu | Semua User (Superadmin, Admin Cabang, Security, Vendor/Mitra) | **MVP Core** | Login email + password dengan opsi demo switcher 4 role |
| 2 | **SCR-02** | Dashboard Kunjungan & Antrean | Super Admin Pusat, Admin Cabang, Vendor/Mitra | **MVP Core** | Monitoring kunjungan cabang/POP, tab approval queue, metrik ringkas & isolasi cabang |
| 3 | **SCR-03** | Form Pengajuan Kunjungan | Vendor/Mitra, Admin Cabang, Superadmin | **MVP Core** | Form terpadu: Pilih Cabang/POP/miniPOP, tujuan (splicing/maint/troubleshoot), jadwal, & tim teknisi |
| 4 | **SCR-04** | Detail & QR Kunjungan | Semua User (sesuai hak akses & cabang) | **MVP Core** | Rincian tim teknisi, timeline status, kartu QR check-in (prioritas mobile atas), tombol Cancel/Reschedule |
| 5 | **SCR-05** | Security Gate / Site Check-in | Security / Petugas Cabang/POP Terkait | **MVP Core** | Antrean hari ini terkunci di cabang penugasan, scan QR / input manual Visit ID, tombol Check-in & Check-out instan |

---

## 2. Base Layout & App Shells (Standarisasi Shell Antarmuka)

| Kode Shell | Nama Layout Shell | Target Pengguna | Karakteristik Utama |
|---|---|---|---|
| **SHELL-01** | Superadmin App Shell | Superadmin (Pusat) | Dark Sidebar 260px (5 menu) + Topbar dengan Branch Switcher dropdown |
| **SHELL-02** | Admin Cabang App Shell | Admin Cabang / POP | White Clean Sidebar 250px + Topbar Locked Branch Badge & Quick Action Satpam |
| **SHELL-03** | Security Gate Kiosk Shell | Petugas Security | Kiosk Mode (Zero Sidebar) + Live Digital Clock + Tab Antrean Sentuh 52px |
| **SHELL-04** | Vendor/Mitra Portal Shell | Vendor / Teknisi Eksternal | Mobile-First Topbar + Bottom Navigation Bar 3 Tab (Tombol Ajukan Menonjol di Tengah) |

---

## 3. Modals & Overlays MVP (Komponen Ringan)

1. **Modal Approve Kunjungan**: Konfirmasi persetujuan kunjungan oleh Admin Cabang / Superadmin (di SCR-02 & SCR-04).
2. **Modal Reject Kunjungan**: Konfirmasi penolakan dengan input textarea alasan wajib (di SCR-02 & SCR-04).
3. **Modal Reschedule Kunjungan**: Pemilihan rentang tanggal baru & alasan pergeseran jadwal (di SCR-04).
4. **Modal Registrasi & Kelola Satpam Cabang**: Pendaftaran akun security baru dan pengelolaan status aktif/nonaktif oleh Admin Cabang (cabang terkunci) atau Superadmin (pilih cabang) di SCR-02.
5. **Modal Fullscreen QR Code**: Tampilan QR Code resolusi tinggi untuk ditunjukkan ke scanner gerbang (di SCR-04).
6. **Toast Notifications (Sonner)**: Notifikasi respon cepat (hijau = sukses, merah = gagal) di atas layar.

---

## 3. Catatan Penyederhanaan & RBAC Sektor ISP
- **Multi-Branch RBAC Terisolasi**: Superadmin di kantor pusat memiliki akses monitoring dan approval seluruh cabang. Admin Cabang hanya melihat, menyetujui, dan meregistrasikan security untuk cabangnya sendiri (`location_id`). Security hanya memverifikasi pengunjung di gerbang cabangnya.
- **Emergency Evacuation List Dihapus**: Karena server dan perangkat THC tersebar di puluhan Kantor Cabang, POP, dan miniPOP (bukan 1 gedung kantor tunggal), evakuasi gedung tidak relevan.
- **Monitoring Live On-Site**: Cukup gunakan filter status `sedang di lokasi` (`status = visiting`) di **SCR-02 (Dashboard Utama)** untuk memantau siapa saja teknisi yang sedang bekerja di POP tertentu.

---

## 4. Evolusi: Halaman Mandiri Back-Office (di Luar 5 Layar Inti)

Setiap item sidebar kini membuka halaman nyata (bukan 404), semuanya memakai
ulang permukaan/komponen SCR-02 tanpa logika ganda — dijaga RBAC per peran:

| Rute | Nama | Peran | Isi (reuse) |
|---|---|---|---|
| `/approvals` | Antrean Approval | Superadmin, Admin Cabang | Irisan `requested` + Setujui/Tolak (VisitTable/VisitCards + modal) |
| `/security` | Kelola Satpam | Superadmin, Admin Cabang | Panel kelola satpam (form + daftar + toggle + hapus) |
| `/facilities` | Fasilitas & Cabang | Superadmin | CRUD lokasi + toggle aktif |
| `/users` | User & Vendor | Superadmin | CRUD admin/Vendor/Mitra + toggle/hapus status |
| `/qr` | Tiket QR Aktif | Vendor/Mitra | Resolver ke SCR-04 (kartu QR above-the-fold) |
