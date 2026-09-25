# Prompt Templates untuk Google Stitch

## Aturan Umum

1. **Satu prompt = satu screen.** Jangan gabung.
2. **Selalu lampirkan design system** di awal prompt.
3. **Sebutkan bahasa UI:** Indonesia.
4. **Sebutkan device target:** desktop / tablet / mobile.
5. **Sebutkan role** yang akses screen.
6. Setelah generate, refine dengan prompt tambahan kalau perlu.

---

## Prompt Base (Selalu Disertakan)

```text
Design system:
- Primary color: #DE1B1B (merah)
- Background: #F5F7FA
- Card: putih, rounded-xl, shadow-sm, padding 24px
- Font: Inter, heading bold, body regular 14px
- Button primary: bg #DE1B1B, text putih, rounded-lg, uppercase, semibold
- Input: height 40px, border #D1D5DB, rounded-lg
- Status badge: rounded-md, padding 4px 8px, 11px uppercase bold
  - visiting/requested: bg #DBEAFE text #1E40AF
  - approved/completed: bg #DCFCE7 text #166534
  - rejected/not_visit: bg #FEE2E2 text #991B1B
  - cancelled: bg #F3F4F6 text #6B7280
  - rescheduled: bg #FEF3C7 text #92400E
- Sidebar: 256px, putih, border-right #E5E7EB, item active bg #FEE2E2 text #DE1B1B
- Navbar: 64px, putih, border-bottom #E5E7EB, logo kiri, Help + bell + avatar kanan
- Bahasa UI: Indonesia
```

---

## Template Prompt per Screen

### INT-01: Login Internal

```text
Buat halaman login internal untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Split 2 kolom (desktop), 1 kolom (mobile)
- Kiri (60%): gradient merah ke dark, ilustrasi data center, tagline "THC Visitor Management"
- Kanan (40%): card putih centered max-width 400px
  - Logo THC
  - Heading "Selamat Datang" (24px bold)
  - Subtext "Login dengan akun SSO THC Anda"
  - Button primary "Login dengan SSO"
  - Link kecil "Butuh bantuan?"
- Footer: copyright + versi

Device: desktop
```

### INT-02: Dashboard List Visits

```text
Buat halaman dashboard untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Navbar atas fixed: logo THC kiri, Help + bell notifikasi + avatar + email kanan
- Sidebar kiri fixed 256px: Dashboard (active), Visits, Approvals, Check-in/out, Vendors, Reports, Audit Log, Admin
- Konten (margin-left 256px, padding 24px):
  - Page title "THC Visitor Management" (24px bold)
  - Subtitle "Kelola semua kunjungan ke fasilitas THC" (14px muted)
  - Filter bar card putih: 3 dropdown (Location, Purpose, Status), date range picker, search box "Search Visit ID atau nama PIC", button primary "Request Site Visit" di kanan
  - Stats row 4 card: Total Visits (128), Approved (45), Visiting (12), Completed (89)
  - List card grid 2 kolom: tiap card berisi Visit ID (bold), PIC Name, Purpose, Location, Visit Date, Request Date, Status badge
  - Pagination bawah

Device: desktop
```

### INT-03: Detail Visit

```text
Buat halaman detail visit untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Navbar + sidebar sama seperti dashboard
- Breadcrumb: Dashboard > Visits > VST-9548545669
- Header card: Visit ID (24px bold) + status badge "approved" di kiri, button group di kanan: Approve (primary), Reject (danger), Reschedule (secondary), Cancel (ghost)
- Tabs: Detail | Visitors | History | Attachments (tab Detail active)
- Tab Detail berisi:
  - Card "Informasi Kunjungan": PIC Name, Email, Phone, Vendor, Location (dengan peta kecil), Purpose (multi badge), Visit Date, Request Date, Notes
  - Card "Status Timeline": vertical timeline dengan dot warna (requested hijau, approved hijau, visiting biru, completed abu)
- Card terpisah per section

Device: desktop
```

### INT-04: Approval Queue

```text
Buat halaman approval queue untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Navbar + sidebar sama
- Page title "Approval Queue" (24px bold)
- Stats row: Pending (12), SLA Reminder (3), Overdue (1) - card dengan angka besar
- Filter: date range, location, urgency dropdown
- List card full width (1 kolom):
  - Tiap card border-left 4px (kuning kalau > 6 jam, merah kalau > 24 jam)
  - Visit ID, PIC, Location, Visit Date
  - Badge SLA kanan atas: "Menunggu 2 jam" (kuning) / "Overdue 26 jam" (merah)
  - Button group kanan: Approve (primary), Reject (danger), Detail (ghost)
- Empty state: "Semua request sudah diproses"

Device: desktop
```

### INT-05: Check-in/out Security

```text
Buat halaman check-in/out untuk Security di aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout (optimasi tablet landscape):
- Header: "Check-in / Check-out" (24px bold) + tanggal hari ini
- Split 2 kolom:
  - Kiri (40%): card putih dengan frame QR scanner besar (border dashed), button primary "Scan QR", divider "atau", input "Input Visit ID manual", button "Cari"
  - Kanan (60%): tabs (Akan Datang | Sedang di Lokasi | Selesai), list card visitor: avatar + nama, PIC, location, waktu, status badge, button aksi (Check-in / Check-out)
- Font besar, button min 48px height, kontras tinggi

Device: tablet landscape
```

### INT-06: Emergency List

```text
Buat halaman emergency evacuation list untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Header merah dominan: "EMERGENCY EVACUATION LIST" (28px bold putih) + timestamp real-time
- Filter Location dropdown (wajib)
- Stats card: "Total Visitor di Lokasi: 23" (angka besar 48px)
- Table visitor: Foto avatar, Nama, PIC, Vendor, Waktu Check-in, Lokasi, Button "Tandai Evakuasi"
- Button besar merah full width: "TRIGGER EMERGENCY ALERT"
- Footer: kontak darurat

Device: tablet / desktop, print-friendly
```

### INT-08: Admin Locations

```text
Buat halaman admin lokasi untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Navbar + sidebar sama
- Page title "Manajemen Lokasi" (24px bold) + button primary "Tambah Lokasi" di kanan
- Grid card 3 kolom: tiap card berisi nama lokasi (18px bold), address, city, badge timezone (WIB/WITA/WIT), toggle active, button Edit & Delete
- Modal Tambah/Edit: Nama, Address, City, Timezone dropdown, Is Active toggle

Device: desktop
```

### INT-12: Reporting

```text
Buat halaman reporting untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Navbar + sidebar sama
- Page title "Laporan" (24px bold)
- Filter bar: date range, location, status, vendor
- Stats card 4: Total Visits, Completion Rate, Average Duration, No-show Rate
- Chart area 2 kolom: line chart (visits per hari), bar chart (visits per lokasi)
- Pie chart status distribution
- Table detail visit
- Button "Export CSV" & "Export Excel" kanan atas

Device: desktop
```

### EXT-01: Login Eksternal

```text
Buat halaman login eksternal untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout (mobile-first):
- Full screen centered
- Logo THC atas
- Card putih max-width 400px:
  - Step 1: Input email + CAPTCHA + button primary "Kirim OTP"
  - Step 2: Input OTP 6 digit (box besar auto-focus) + button primary "Verifikasi"
  - Link "Kirim ulang OTP" (muncul setelah 60 detik)
- Footer: Privacy Policy + Terms

Device: mobile
```

### EXT-02: Dashboard Eksternal

```text
Buat halaman dashboard eksternal untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout (mobile-first):
- Navbar atas: logo + bell + avatar
- Greeting: "Halo, Wawan" (20px bold) + subtitle
- Quick action card primary: "Buat Request Baru" (besar, full width)
- Stats 2 card: Request Aktif (3), Total Kunjungan (12)
- List kunjungan card stack: Visit ID + status badge, Location, Visit Date, button "Lihat Detail"
- Bottom nav (mobile): Dashboard, Request, Status, Feedback, Profil

Device: mobile
```

### EXT-03: Form Request

```text
Buat halaman form request site visit untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout (mobile-first):
- Header: "Buat Request Site Visit" + tombol back
- Progress indicator 1/3
- Form card putih:
  - Section "Informasi PIC": Nama, Email, Phone (pre-filled)
  - Section "Lokasi & Tujuan": Location dropdown, Purpose multi-select checkbox badge
  - Section "Jadwal": Date picker start, Time picker start, Date picker end, Time picker end, toggle "Multi-hari"
  - Section "Visitor": dynamic list (nama, ID number, phone, foto opsional), button "+ Tambah Visitor" (max 10)
  - Section "Catatan": textarea
  - Section "Attachment": file upload
  - Checkbox NDA
- Button sticky bawah: "Submit Request" (primary), "Simpan Draft" (ghost)

Device: mobile
```

### EXT-04: Detail & Status

```text
Buat halaman detail & status visit untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout (mobile-first):
- Header: Visit ID (20px bold) + status badge
- Timeline status vertical: Requested (timestamp hijau), Approved (timestamp hijau), Visiting (timestamp biru), Completed (abu)
- Card "Informasi Kunjungan": Location dengan peta, Purpose badge, Visit Date, PIC Name, Visitor list avatar
- Card "QR Code" (muncul kalau approved): QR besar, button "Download QR", text "Tunjukkan QR ini ke Security saat check-in"
- Card "Aksi": button Reschedule, Cancel, Isi Feedback
- Button back

Device: mobile
```

---

## Prompt Tambahan (Modals)

### Modal Approve

```text
Buat modal konfirmasi approve untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Overlay rgba(0,0,0,0.4)
- Card putih rounded-2xl max-width 480px padding 24px
- Header "Approve Request?" (18px semibold) + icon check hijau
- Body: "Anda akan menyetujui kunjungan VST-9548545669 oleh Wawan Darmawan ke THC Jakarta - Karet pada 17 Sep 2026."
- Textarea "Catatan (opsional)"
- Footer: button secondary "Batal", button primary "Approve"

Device: desktop + mobile
```

### Modal Reject

```text
Buat modal reject untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Overlay
- Card putih max-width 480px
- Header "Reject Request?" + icon X merah
- Body: info visit
- Textarea "Alasan reject" (wajib, min 10 karakter)
- Footer: button secondary "Batal", button danger "Reject"

Device: desktop + mobile
```

### Modal QR Code

```text
Buat modal QR code untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Overlay
- Card putih max-width 400px
- Header "QR Code Check-in" + tombol close
- QR code besar (250x250)
- Visit ID di bawah QR
- Text "Tunjukkan QR ini ke Security saat check-in"
- Button primary "Download QR"

Device: mobile
```

### Modal NDA Digital

```text
Buat modal NDA digital signature untuk aplikasi "THC Visitor Management".

[DESIGN SYSTEM]

Layout:
- Overlay
- Card putih max-width 600px
- Header "Non-Disclosure Agreement"
- Body: scrollable text NDA (max-height 300px)
- Canvas signature area (border dashed, 200px height)
- Text "Tanda tangan di area di atas"
- Checkbox "Saya setuju dengan NDA"
- Footer: button secondary "Batal", button primary "Tanda Tangan"

Device: tablet
```

---

## Tips Refine Prompt

Kalau hasil generate kurang pas, tambahkan:

- "Buat lebih clean dan minimalis"
- "Kurangi shadow, tambah border subtle"
- "Perbesar spacing antar card"
- "Ganti font ke Inter"
- "Tambah hover state pada button"
- "Buat responsive untuk mobile"
- "Tambah empty state"
- "Tambah loading skeleton"

Kalau hasil terlalu ramai:

- "Hilangkan dekorasi, fokus ke konten"
- "Kurangi warna, pakai putih dominan"

Kalau hasil terlalu plain:

- "Tambah ilustrasi di empty state"
- "Tambah icon di setiap section"

---

## Ringkasan Paket Docs

| File | Isi | Wajib? |
|------|-----|--------|
| `00-README.md` | Panduan pakai | Ya |
| `01-screen-inventory.md` | Daftar 19 screen | Ya |
| `02-design-system.md` | Color, typography, komponen | Ya |
| `03-user-flow.md` | Navigasi antar screen | Ya |
| `04-screen-specs-internal.md` | 14 screen internal | Ya |
| `05-screen-specs-external.md` | 5 screen eksternal | Ya |
| `06-prompt-templates.md` | Prompt siap copy ke Stitch | Ya |

**Urutan pakai:**

1. Baca `00` → `01` → `02` → `03`
2. Untuk tiap screen, buka `04` atau `05`
3. Copy prompt dari `06` ke Stitch
4. Refine kalau perlu

**Konsistensi dengan docs lain:**

- PRD v3.0 → section 5 (Roles), 7 (Functional), 13 (UI/UX)
- ERD → entitas & field (Visit, Visitor, Location, dll)
- OpenAPI → endpoint & error handling
