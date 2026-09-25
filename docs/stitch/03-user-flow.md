# User Flow – THC Visitor Management

## 1. Flow Internal – THC Admin

```text
Login SSO (INT-01)
    |
    v
Dashboard List Visits (INT-02)
    |
    +---> Detail Visit (INT-03)
    |         |
    |         +---> Approve / Reject / Reschedule (modal)
    |         +---> Lihat Riwayat Status
    |
    +---> Approval Queue (INT-04)
    |         |
    |         +---> Approve / Reject (modal)
    |
    +---> Admin Panel
    |         |
    |         +---> Locations (INT-08)
    |         +---> Purposes (INT-09)
    |         +---> Vendors (INT-10)
    |         +---> Users (INT-07) - Super Admin
    |         +---> Roles (INT-11) - Super Admin
    |
    +---> Reporting (INT-12)
    |         |
    |         +---> Export CSV/Excel
    |
    +---> Audit Log (INT-13)
    |
    +---> Profil & 2FA (INT-14)
```

## 2. Flow Internal – Security

```text
Login SSO (INT-01)
    |
    v
Dashboard Check-in/out (INT-05)
    |
    +---> Scan QR / Input Visit ID
    |         |
    |         +---> Verifikasi Identitas
    |         +---> Ambil Foto
    |         +---> Tanda Tangan NDA (modal)
    |         +---> Cetak Badge
    |         +---> Check-in
    |
    +---> Check-out
    |
    +---> Emergency List (INT-06)
    |         |
    |         +---> Trigger Emergency Alert
    |
    +---> Profil (INT-14)
```

## 3. Flow Eksternal – PIC / Vendor

```text
Login Email + OTP (EXT-01)
    |
    v
Dashboard Eksternal (EXT-02)
    |
    +---> Request Site Visit (EXT-03)
    |         |
    |         +---> Isi Form
    |         +---> Validasi
    |         +---> Submit
    |         +---> Toast sukses
    |
    +---> Detail & Status Visit (EXT-04)
    |         |
    |         +---> Lihat Status
    |         +---> Reschedule (modal)
    |         +---> Cancel (modal)
    |         +---> Lihat QR Code (modal)
    |
    +---> Feedback (EXT-05)
    |
    +---> Logout
```

## 4. Flow End-to-End (Happy Path)

```text
PIC (Eksternal)                    THC Admin                    Security
    |                                  |                            |
    |-- Request Site Visit ----------->|                            |
    |                                  |                            |
    |                                  |-- Review & Approve ------->|
    |                                  |                            |
    |<-- Notifikasi Approved ----------|                            |
    |                                  |                            |
    |-- Datang ke Lokasi ------------------------------------------>|
    |                                  |                            |
    |                                  |                  Check-in -|
    |                                  |                            |
    |                                  |<-- Notifikasi Check-in ----|
    |                                  |                            |
    |                                  |                  Check-out |
    |                                  |                            |
    |                                  |<-- Notifikasi Check-out ---|
    |                                  |                            |
    |-- Isi Feedback ----------------->|                            |
```

## 5. Navigasi Antar Screen

### Internal

- Navbar: Logo (ke Dashboard), Help, Notifikasi, Profil
- Sidebar: Dashboard, Visits, Approvals, Check-in/out, Vendors, Reports, Audit Log, Admin
- Breadcrumb di halaman detail: Dashboard > Visits > Detail

### Eksternal

- Navbar: Logo (ke Dashboard), Notifikasi, Profil
- Bottom nav (mobile): Dashboard, Request, Status, Feedback
- Tidak ada sidebar (full width)

## 6. Aturan Navigasi

- User eksternal tidak boleh akses screen internal (redirect ke dashboard eksternal).
- Security tidak boleh akses Admin Panel.
- Setelah approve/reject, redirect ke Approval Queue dengan toast sukses.
- Setelah check-in, redirect ke Emergency List dengan highlight visitor baru.
- Session expired: redirect ke login dengan toast "Sesi berakhir".
- 404: halaman custom dengan CTA ke dashboard.
- 403: halaman custom dengan pesan akses ditolak.
