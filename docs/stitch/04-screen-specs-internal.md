# Screen Specs – Internal

---

## INT-01: Login Internal (SSO)

**Tujuan:** Autentikasi user internal via SSO THC.

**Layout:**

- Full screen, split 2 kolom (desktop), 1 kolom (mobile)
- Kiri (60%): ilustrasi / foto data center + tagline "THC Visitor Management"
- Kanan (40%): card login centered, max-width 400px
  - Logo THC
  - Heading "Selamat Datang"
  - Subtext "Login dengan akun SSO THC Anda"
  - Button primary "Login dengan SSO"
  - Link kecil "Butuh bantuan?"
- Footer: copyright + versi

**Style:**

- BG kiri: gradient merah ke dark
- BG kanan: white
- Card: no shadow, flat

**State:**

- Loading: button spinner
- Error: toast merah "Login gagal, coba lagi"

**Catatan:** Redirect ke IdP THC, bukan form input.

---

## INT-02: Dashboard – List Visits

**Tujuan:** Lihat & kelola semua site visit.

**Layout:**

- Navbar atas (fixed): logo kiri, Help + bell + profil kanan
- Sidebar kiri (fixed, 256px): Dashboard (active), Visits, Approvals, Check-in/out, Vendors, Reports, Audit Log, Admin
- Konten:
  - Page title: "THC Visitor Management" (H1)
  - Subtitle: "Kelola semua kunjungan ke fasilitas THC"
  - Filter bar (card putih):
    - Dropdown "All location"
    - Dropdown "All purpose"
    - Dropdown "All status"
    - Date range picker
    - Search box "Search Visit ID atau nama PIC"
    - Button primary "Request Site Visit" (kanan)
  - Stats row (4 card): Total Visits, Approved, Visiting, Completed
  - List card grid 2 kolom:
    - Visit ID (bold, 14px)
    - PIC Visitor Name
    - Visit Purpose
    - Location
    - Visit Date
    - Request Date
    - Status badge
    - Label 12px muted + value 14px
  - Empty state: icon + "Belum ada kunjungan" + CTA
  - Pagination bawah

**Style:**

- BG page: `#F5F7FA`
- Card: white, rounded-xl, shadow-sm
- Grid: 2 kolom desktop, 1 kolom tablet/mobile

**Interaksi:**

- Klik card → Detail Visit
- Klik "Request Site Visit" → Form Request
- Filter & search real-time

**Responsive:**

- Mobile: sidebar jadi drawer, card 1 kolom

---

## INT-03: Detail Visit

**Tujuan:** Lihat & kelola detail satu kunjungan.

**Layout:**

- Breadcrumb: Dashboard > Visits > VST-XXXX
- Header card:
  - Visit ID (H1) + Status badge
  - Button group kanan: Approve (primary), Reject (danger), Reschedule (secondary), Cancel (ghost)
- Tabs: Detail | Visitors | History | Attachments
- Tab Detail:
  - Section "Informasi Kunjungan":
    - PIC Name, Email, Phone
    - Vendor
    - Location (dengan peta kecil)
    - Purpose (multi badge)
    - Visit Date (start–end)
    - Request Date
    - Notes
  - Section "Status Timeline": vertical timeline dengan icon
- Tab Visitors: table visitor (nama, ID number, phone, foto, NDA status)
- Tab History: table status history (status, changed by, waktu, notes)
- Tab Attachments: grid file preview

**Style:**

- Card terpisah per section
- Timeline: line vertical dengan dot warna status

**Aksi:**

- Approve → modal konfirmasi
- Reject → modal dengan textarea alasan (wajib)
- Reschedule → modal dengan date picker + alasan
- Cancel → modal konfirmasi

---

## INT-04: Approval Queue

**Tujuan:** Lihat & proses request yang butuh approval.

**Layout:**

- Page title: "Approval Queue"
- Stats: Pending (angka besar), SLA Reminder, Overdue
- Filter: date range, location, urgency
- List card (1 kolom, full width):
  - Visit ID, PIC, Location, Visit Date
  - Badge: "Menunggu X jam" (kuning kalau > 6 jam, merah kalau > 24 jam)
  - Button group: Approve, Reject, Detail
- Empty state: "Semua request sudah diproses"

**Style:**

- Card dengan border-left 4px sesuai urgency
- Badge SLA di kanan atas card

**Aksi:**

- Approve langsung dari card (modal konfirmasi)
- Reject dari card (modal alasan)
- Klik card → Detail Visit

---

## INT-05: Check-in/out (Security)

**Tujuan:** Security scan QR & kelola kunjungan hari ini.

**Layout (optimasi tablet landscape):**

- Header: "Check-in / Check-out" + tanggal hari ini
- Split 2 kolom:
  - Kiri (40%): QR Scanner area
    - Frame scanner besar
    - Button "Scan QR"
    - Divider "atau"
    - Input "Input Visit ID manual"
    - Button "Cari"
  - Kanan (60%): List visitor hari ini
    - Tabs: Akan Datang | Sedang di Lokasi | Selesai
    - Card visitor: nama, PIC, location, waktu, status
    - Button aksi: Check-in / Check-out
- Modal Check-in:
  - Info visitor
  - Upload/take foto (camera)
  - NDA digital signature (canvas)
  - Button "Check-in"
- Modal Check-out: konfirmasi

**Style:**

- Font besar untuk readability di lapangan
- Button besar (min 48px height)
- Warna kontras tinggi

**Interaksi:**

- Scan QR → auto lookup
- Tidak ketemu → toast error + fallback manual
- Sukses check-in → toast hijau + refresh list

---

## INT-06: Emergency Evacuation List

**Tujuan:** Daftar visitor yang sedang di lokasi (untuk evakuasi).

**Layout:**

- Header merah: "EMERGENCY EVACUATION LIST" + timestamp real-time
- Filter: Location dropdown (wajib)
- Stats: Total Visitor di Lokasi (angka besar)
- Table/list visitor:
  - Foto (avatar)
  - Nama
  - PIC
  - Vendor
  - Waktu Check-in
  - Lokasi
  - Button "Tandai Evakuasi"
- Button besar merah: "TRIGGER EMERGENCY ALERT"
- Footer: kontak darurat

**Style:**

- Warna merah dominan
- Font besar
- Print-friendly

**Aksi:**

- Trigger alert → modal konfirmasi → notifikasi ke semua
- Tandai evakuasi → update status

---

## INT-07: Admin Panel – Users

**Tujuan:** Manage user internal & eksternal.

**Layout:**

- Page title: "Manajemen User"
- Button primary: "Tambah User"
- Filter: role, type, status, search
- Table user:
  - Avatar + Nama
  - Email
  - Role
  - Type (badge)
  - Status (badge)
  - Last Login
  - Aksi: Edit, Reset, Blacklist
- Modal Tambah/Edit User:
  - Nama
  - Email
  - Phone
  - Role dropdown
  - Type dropdown
  - Vendor (kalau eksternal)
  - Status
- Pagination

**Style:**

- Table standar
- Badge: internal (biru), external (kuning)
- Status: active (hijau), inactive (abu), blacklisted (merah)

---

## INT-08: Admin Panel – Locations

**Tujuan:** Manage lokasi THC.

**Layout:**

- Page title: "Manajemen Lokasi"
- Button primary: "Tambah Lokasi"
- Grid card (3 kolom):
  - Nama lokasi (H3)
  - Address
  - City
  - Timezone (badge)
  - Status active/inactive (toggle)
  - Aksi: Edit, Delete
- Modal Tambah/Edit:
  - Nama
  - Address
  - City
  - Timezone dropdown (WIB/WITA/WIT)
  - Is Active toggle

---

## INT-09: Admin Panel – Purposes

**Tujuan:** Manage purpose kunjungan.

**Layout:**

- Page title: "Manajemen Purpose"
- Button primary: "Tambah Purpose"
- Table:
  - Nama
  - Status
  - Aksi
- Modal: Nama + Is Active

**Catatan:** Default purpose: Survey, Troubleshoot, Maintenance, Operation. Bisa ditambah.

---

## INT-10: Admin Panel – Vendors

**Tujuan:** Manage vendor eksternal.

**Layout:**

- Page title: "Manajemen Vendor"
- Button primary: "Tambah Vendor"
- Filter: status, search
- Table:
  - Nama Vendor
  - Contact Person
  - Email
  - Phone
  - Status (badge)
  - Aksi: Edit, Blacklist
- Modal Tambah/Edit:
  - Nama Vendor
  - Contact Person
  - Email
  - Phone
  - Status
- Modal Blacklist: textarea alasan (wajib)

---

## INT-11: Admin Panel – Roles

**Tujuan:** Manage role & permission.

**Layout:**

- Page title: "Manajemen Role"
- Button primary: "Tambah Role"
- Table:
  - Nama Role
  - Jumlah User
  - Aksi
- Modal Edit Permission:
  - Checkbox matrix per aksi
  - Group by kategori (Visit, User, Report, dll)

**Catatan:** Role default: Customer, Visitor, Security, THC Admin, Super Admin.

---

## INT-12: Reporting

**Tujuan:** Laporan & export.

**Layout:**

- Page title: "Laporan"
- Filter bar: date range, location, status, vendor
- Stats card (4):
  - Total Visits
  - Completion Rate
  - Average Duration
  - No-show Rate
- Chart area:
  - Line chart: visits per hari
  - Bar chart: visits per lokasi
  - Pie chart: status distribution
- Table detail visit
- Button: "Export CSV", "Export Excel"
- Pagination

**Style:**

- Chart pakai warna primary + semantic
- Responsive: chart stack di mobile

---

## INT-13: Audit Log

**Tujuan:** Lihat riwayat aksi user.

**Layout:**

- Page title: "Audit Log"
- Filter: user, action, entity, date range
- Table:
  - Timestamp
  - User (avatar + nama)
  - Action
  - Entity
  - Entity ID
  - IP
  - Aksi: Detail
- Modal Detail: JSON metadata + user agent
- Pagination

---

## INT-14: Profil & 2FA Setup

**Tujuan:** Lihat profil & setup 2FA.

**Layout:**

- Page title: "Profil Saya"
- Card Informasi:
  - Avatar (editable)
  - Nama
  - Email
  - Phone
  - Role (read-only)
  - Last Login
- Card Keamanan:
  - Status 2FA (aktif/tidak)
  - Button "Setup 2FA" / "Reset 2FA"
  - Modal 2FA: QR code + secret + input verify
- Card Sesi:
  - List device aktif
  - Button "Logout dari semua device"
