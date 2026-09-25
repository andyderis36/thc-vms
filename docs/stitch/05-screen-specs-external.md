# Screen Specs – Eksternal

---

## EXT-01: Login Eksternal (Email + OTP)

**Tujuan:** Autentikasi PIC/Vendor/Visitor via email + OTP.

**Layout (mobile-first):**

- Full screen, centered
- Logo THC di atas
- Card login, max-width 400px:
  - Step 1: Input email + CAPTCHA + Button "Kirim OTP"
  - Step 2: Input OTP (6 digit, auto-focus) + Button "Verifikasi"
  - Link "Kirim ulang OTP" (muncul setelah 60 detik)
- Footer: Privacy Policy + Terms

**Style:**

- BG: white
- Card: no shadow, flat
- Button primary merah
- OTP input: 6 box besar, auto-focus, auto-submit

**State:**

- Loading: button spinner
- Error: toast merah
- Success: redirect ke dashboard

**Catatan:** Setelah login pertama, tampilkan modal consent privacy policy (wajib).

---

## EXT-02: Dashboard Eksternal

**Tujuan:** Overview kunjungan milik PIC.

**Layout (mobile-first):**

- Navbar atas: logo + bell + avatar
- Greeting: "Halo, [Nama]" + subtitle
- Quick action card: "Buat Request Baru" (primary besar)
- Stats (2 card): Request Aktif, Total Kunjungan
- List kunjungan (card stack):
  - Visit ID + status badge
  - Location
  - Visit Date
  - Button "Lihat Detail"
- Empty state: ilustrasi + "Belum ada kunjungan" + CTA
- Bottom nav (mobile): Dashboard, Request, Status, Feedback, Profil

**Style:**

- BG: `#F5F7FA`
- Card: white, rounded-xl, shadow-sm
- Mobile-first, 1 kolom

**Interaksi:**

- Klik card → Detail Visit
- Klik "Buat Request" → Form Request

---

## EXT-03: Form Request Site Visit

**Tujuan:** PIC mengajukan kunjungan.

**Layout:**

- Header: "Buat Request Site Visit" + tombol back
- Progress indicator (opsional): 1/3
- Form (card putih):
  - Section "Informasi PIC": Nama, Email, Phone (pre-filled dari akun)
  - Section "Lokasi & Tujuan":
    - Location dropdown
    - Purpose multi-select (checkbox badge)
  - Section "Jadwal":
    - Date picker start
    - Time picker start
    - Date picker end
    - Time picker end
    - Toggle "Multi-hari"
  - Section "Visitor":
    - Dynamic list: nama, ID number, phone, foto (opsional)
    - Button "+ Tambah Visitor" (max 10)
  - Section "Catatan": textarea
  - Section "Attachment": file upload (opsional)
  - Checkbox NDA: "Saya setuju dengan NDA & safety briefing"
- Button sticky bawah: "Submit Request" (primary)
- Button "Simpan Draft" (ghost)

**Style:**

- Card per section
- Label 13px semibold
- Input 40px height
- Button primary merah, full width di mobile

**Validasi:**

- Wajib isi semua field bertanda *
- Tanggal tidak boleh masa lalu
- Durasi max 8 jam/hari, max 7 hari
- Minimal 1 visitor
- NDA wajib dicentang

**State:**

- Loading: button spinner
- Error: inline error di field + toast
- Success: toast hijau + redirect ke Detail

---

## EXT-04: Detail & Status Visit

**Tujuan:** Lihat detail & status kunjungan.

**Layout:**

- Header: Visit ID (H1) + status badge
- Timeline status (vertical):
  - Requested (timestamp)
  - Approved (timestamp)
  - Visiting (timestamp)
  - Completed (timestamp)
  - Dot warna sesuai status, line abu untuk yang belum
- Card "Informasi Kunjungan":
  - Location (dengan peta)
  - Purpose (badge)
  - Visit Date
  - PIC Name
  - Visitor list (avatar + nama)
- Card "QR Code" (muncul kalau status approved):
  - QR besar
  - Button "Download QR"
  - Text "Tunjukkan QR ini ke Security saat check-in"
- Card "Aksi":
  - Button "Reschedule" (kalau approved)
  - Button "Cancel" (kalau requested/approved)
  - Button "Isi Feedback" (kalau completed)
- Button back

**Style:**

- Card terpisah per section
- Timeline: dot 12px + line 2px
- QR: white card dengan border

**Aksi:**

- Reschedule → modal date picker + alasan
- Cancel → modal konfirmasi + alasan
- QR → modal fullscreen

---

## EXT-05: Feedback Post-Visit

**Tujuan:** PIC mengisi feedback setelah kunjungan.

**Layout:**

- Header: "Feedback Kunjungan" + Visit ID
- Card form:
  - Rating bintang (1–5, besar, clickable)
  - Textarea "Ceritakan pengalaman Anda"
  - Checkbox "Bersedia dihubungi"
- Button "Kirim Feedback" (primary)
- Button "Lewati" (ghost)

**Style:**

- Bintang besar (48px), warna kuning saat aktif
- Textarea min-height 120px

**State:**

- Success: toast + redirect ke dashboard

**Catatan:** Feedback otomatis muncul 1 jam setelah check-out via notifikasi.
