# Briefing QA Manual E2E: THC Visitor Management System

> Dokumen ini untuk pengujian manual blackbox lewat browser. Pendamping `docs/6. QA_CHECKLIST.md`. Checklist itu mencakup kasus API/otomatis. Dokumen ini fokus ke alur browser manual.
> Kalau ada perbedaan antara dokumen ini dan `QA_CHECKLIST.md` soal kontrak API, ikuti `QA_CHECKLIST.md` + `docs/4. openapi.yaml`.

## 1. Ringkasan produk

THC Visitor Management System mengatur izin kunjungan tamu dan teknisi di lingkungan ISP yang tersebar: kantor cabang, POP, dan miniPOP. Penguji berperan sebagai tiap role dan menelusuri alur penuh dari pengajuan sampai check-out.

Siklus status kunjungan:

`requested` → `approved` → `visiting` → `completed`, plus cabang `rejected` / `cancelled`.

Aturan kunci yang selalu berlaku:

- Jendela check-in: `start_date - 2 jam` sampai `end_date + 2 jam`. Di luar itu tolak dengan 400.
- Satu tiket QR dipakai untuk check-in dan check-out.
- Foto KTP dan foto selfie teknisi bisa dibuka lewat klik-preview di halaman detail dan di popup gate.

## 2. Lingkungan uji

### 2.1 Varian A: lokal

| Komponen | URL |
|---|---|
| Frontend (FE) | http://localhost:3210 |
| Backend (BE) | http://localhost:8080/api/v1 |
| MinIO console (opsional) | http://localhost:9001 |

Langkah siap uji lokal:

1. Pastikan backend dan frontend jalan di port di atas.
2. Buka FE di Chrome desktop dan Chrome mobile emulation atau HP fisik satu jaringan.
3. Siapkan satu akun tiap role (lihat Bagian 3).
4. Kosongkan cache atau pakai jendela Incognito tiap ganti role.

### 2.2 Varian B: tunnel demo (cloudflared quick-tunnel)

1. Panitia mengumumkan sepasang URL sesi itu, contoh pola: satu URL FE dan satu URL BE yang berbeda.
2. URL tunnel acak dan berubah tiap run. Pakai pasangan yang diumumkan sesi itu saja. Jangan campur URL sesi lama dengan sesi baru.
3. Biarkan terminal tunnel tetap terbuka selama pengujian. Kalau terminal tertutup, semua URL sesi itu mati.
4. FE tunnel sudah menunjuk ke BE tunnel pasangannya. Jangan ganti manual ke `localhost:8080` saat uji tunnel.

## 3. Akun demo dan role

Password semua akun: `Password123!`

> Label di layar berbeda dari nama enum role: `security` tampil sebagai Pengawas, `admin` tampil sebagai Koordinator Wilayah. Email login dan path API tetap memakai pola lama (`security*@thc.com`, `/users/security`).

| Role | Akun | Cakupan |
|---|---|---|
| super_admin | superadmin@thc.net.id | Global, HQ. Lintas cabang. Satu-satunya role yang boleh DELETE master. |
| admin | admin1@thc.com | Pontianak HQ, koordinator cabang sendiri |
| admin | admin2@thc.com | Sambas |
| admin | admin3@thc.com | Mempawah |
| admin | admin4@thc.com | Singkawang |
| admin | admin5@thc.com | Aruk |
| security | security1a, security1b | HQ (kios cabang sendiri) |
| security | security2a, security2b | Sambas |
| security | security3a, security3b | Mempawah |
| security | security4a, security4b | Singkawang |
| security | security5a, security5b | Aruk |
| vendor | vendor1a (Lintas Fiber), vendor1b (Daya Power Mandiri), dst. | Hanya data milik sendiri, pegang QR pass |

Catatan RBAC untuk semua sesi:

- `super_admin`: akses global.
- `admin`: terisolasi cabang. Menyetujui cabang sendiri, mengelola pengawas sendiri, boleh check-in cadangan (dual-role) di cabang sendiri.
- `security`: kios cabang sendiri. Check-in dan check-out cabang sendiri.
- `vendor`: mengajukan kunjungan sendiri, melihat status milik sendiri, membawa QR.
- Akses lintas cabang oleh `admin`/`security` harus 403. Vendor hanya melihat baris miliknya.

## 4. Peta rute dan API (rujukan cepat penguji)

Rute FE: `/login`, `/` (redirect sesuai role), `/dashboard`, `/approvals`, `/facilities`, `/security`, `/gate`, `/qr`, `/users`, `/visits/new`, `/visits/[id]`.

Grup API: `/health`, `/ready`, `/auth/login|me|logout`, `/users/security` (+ `/{id}`, + `/{id}/status`), `/locations` (+ `/{id}`), `/users` (+ `/{id}`, + `/{id}/status`), `/purposes`, `/vendors`, `/uploads`, `/visits` (+ `/{id}`, `/{id}/file`, `/{id}/approve|reject|reschedule|cancel`, `/{id}/qr`, `/{id}/checkin|checkout`).

## 5. Sesi uji manual

Tandai tiap kotak setelah lolos. Tulis ID bug di kolom kanan bila gagal.

### Sesi 1. Auth dan sesi

| ID | Role | Langkah | Hasil yang diharapkan | Lolos |
|---|---|---|---|---|
| S1-01 | Semua | Buka `/login`, masuk dengan email dan password benar | Masuk ke `/` lalu redirect ke dashboard sesuai role | - [ ] |
| S1-02 | Semua | Masuk dengan password salah | Tetap di login, pesan kredensial tidak valid | - [ ] |
| S1-03 | Semua | Buka `/dashboard` langsung tanpa login | Dilempar ke `/login` | - [ ] |
| S1-04 | Semua | Login benar, lalu logout lewat menu, lalu tekan Back dan buka `/dashboard` | Tetap diminta login, sesi lama tidak bisa dipakai | - [ ] |
| S1-05 | vendor | Login sebagai vendor1a, catat tampilan awal | Melihat ringkasan kunjungan miliknya saja | - [ ] |

### Sesi 2. Pengajuan vendor (termasuk selfie, vendor per teknisi, dropdown purpose)

| ID | Role | Langkah | Hasil yang diharapkan | Lolos |
|---|---|---|---|---|
| S2-01 | vendor | Buka `/visits/new`. Isi tanggal valid, pilih lokasi cabang, pilih purpose dari dropdown, isi 2 teknisi, unggah Surat Tugas PDF kecil dan foto selfie tiap teknisi | Form tersimpan, status `requested`, redirect ke `/visits/[id]` | - [ ] |
| S2-02 | vendor | Ulangi S2-01 tapi set teknisi 1 memakai vendor katalog (mis. Lintas Fiber) dan teknisi 2 memakai vendor lain (mis. Daya Power Mandiri) | Keduanya tersimpan per teknisi, nama vendor tampil benar di detail | - [ ] |
| S2-03 | vendor | Coba simpan tanpa memilih purpose sama sekali | Validasi menolak, data tidak terkirim | - [ ] |
| S2-04 | vendor | Unggah file di atas 5 MB | Ditolak dengan pesan batas 5 MB | - [ ] |
| S2-05 | vendor | Unggah file `.exe` atau `.zip` sebagai Surat Tugas | Ditolak, hanya `pdf`, `jpeg`, `png` yang diterima | - [ ] |
| S2-06 | vendor | Isi `start_date` lebih lambat dari `end_date`, coba simpan | Validasi menolak sebelum terkirim | - [ ] |

### Sesi 3. Alur approval

| ID | Role | Langkah | Hasil yang diharapkan | Lolos |
|---|---|---|---|---|
| S3-01 | admin | Sebagai admin cabang, buka `/approvals`, setujui satu kunjungan `requested` milik cabangnya | Status jadi `approved`, QR aktif untuk vendor | - [ ] |
| S3-02 | admin | Tolak satu kunjungan `requested` lain milik cabangnya dengan alasan tertulis | Status jadi `rejected`, alasan tampil di sisi vendor | - [ ] |
| S3-03 | admin | Reschedule satu kunjungan ke tanggal baru, lalu coba check-in langsung sebelum approve ulang | Status `rescheduled`, check-in ditolak sampai disetujui ulang. Setelah approve ulang, check-in bisa jalan | - [ ] |
| S3-04 | admin | Batalkan satu kunjungan lewat aksi cancel | Status jadi `cancelled` dan keluar dari antrean aktif | - [ ] |
| S3-05 | vendor | Sebagai vendor, buka halaman kunjungan yang menunggu approval | Tidak ada tombol Approve, Reject, atau Check-in | - [ ] |

### Sesi 4. Gate check-in dan check-out (termasuk triple-mode scan dan popup)

Triple-mode di `/gate`: (1) kamera langsung, (2) upload gambar QR dari galeri, (3) ketik Visit ID manual.

| ID | Role | Langkah | Hasil yang diharapkan | Lolos |
|---|---|---|---|---|
| S4-01 | security | Buka `/gate`, pilih tab kamera, pindai QR kunjungan `approved` dalam jendela waktu | Popup tampil, konfirmasi check-in sukses, status jadi `visiting` | - [ ] |
| S4-02 | security | Di `/gate`, pilih tab upload gambar, unggah screenshot QR yang sama dari galeri atau chat | QR terdecode, detail tamu tampil, verifikasi sukses | - [ ] |
| S4-03 | security | Di `/gate`, ketik Visit ID manual (contoh dari tiket uji) | Sistem menemukan tiket dan menampilkan detail tamu | - [ ] |
| S4-04 | security | Klik Visit ID pada kartu antrean gate tanpa scan | Popup detail terbuka sama seperti hasil pindaian, berisi foto KTP dan selfie, nama vendor, tombol aksi sesuai status | - [ ] |
| S4-05 | security | Klik foto selfie atau KTP di popup gate | Preview besar terbuka, bisa ditutup dan tampilan kembali seperti semula | - [ ] |
| S4-06 | security/admin | Eksekusi check-out dari popup pada kunjungan `visiting` | Status jadi `completed`, waktu selesai tercatat | - [ ] |
| S4-07 | admin | Sebagai admin cabang yang sama, eksekusi check-in cadangan saat pengawas patroli | Check-in sukses dan tercatat atas nama admin itu | - [ ] |

### Sesi 5. Back-office: users, security, facilities (termasuk DELETE superadmin-only)

| ID | Role | Langkah | Hasil yang diharapkan | Lolos |
|---|---|---|---|---|
| S5-01 | admin | Buka `/security`, daftarkan pengawas baru di cabangnya | Akun tercipta dan terkunci di cabang admin itu | - [ ] |
| S5-02 | admin | Nonaktifkan dan aktifkan kembali satu akun pengawas (`/{id}/status`) | Status berubah dan tercermin di daftar | - [ ] |
| S5-03 | admin | Buka `/users`, kelola user dalam cabangnya | Hanya user cabang sendiri yang bisa dikelola | - [ ] |
| S5-04 | super_admin | Buka `/facilities` dan `/users`, ubah data lalu hapus satu data uji lewat DELETE | Ubah dan hapus sukses lintas cabang | - [ ] |
| S5-05 | admin | Coba akses fungsi DELETE yang sama di `/facilities` atau `/users` | Ditolak. Tidak ada tombol hapus atau request gagal 403 | - [ ] |
| S5-06 | security/vendor | Coba buka langsung `/users`, `/security`, `/facilities` lewat URL | Ditolak atau diarahkan pulang sesuai role | - [ ] |

### Sesi 6. QR pass vendor

| ID | Role | Langkah | Hasil yang diharapkan | Lolos |
|---|---|---|---|---|
| S6-01 | vendor | Setelah kunjungan disetujui, buka `/visits/[id]` atau `/qr` di HP | Kartu QR tampil paling atas layar tanpa perlu scroll (above-the-fold) | - [ ] |
| S6-02 | vendor | Pakai QR yang sama untuk check-in lalu check-out di gate | Satu tiket berlaku untuk kedua aksi, status bergerak `approved` ke `visiting` ke `completed` | - [ ] |
| S6-03 | vendor | Buka kembali QR kunjungan yang sudah `completed` atau `rejected` | QR tidak bisa dipakai check-in lagi, ada pesan status yang jelas | - [ ] |

### Sesi 7. Akses file dan foto

| ID | Role | Langkah | Hasil yang diharapkan | Lolos |
|---|---|---|---|---|
| S7-01 | vendor/admin/security | Di halaman detail `/visits/[id]`, klik tautan Surat Tugas dan klik foto KTP tiap teknisi | Berkas terbuka (PDF atau gambar), foto tampil preview besar | - [ ] |
| S7-02 | admin/security | Buka kembali tautan file yang sama beberapa menit kemudian | Masih terbuka. Kalau presigned URL kedaluwarsa, muat ulang halaman untuk tautan baru (lihat Bagian 7) | - [ ] |

### Sesi 8. Matriks negatif lintas cabang

Gunakan dua cabang berbeda, mis. Pontianak HQ dan Sambas. Ulangi tiap baris untuk pasangan cabang lain bila waktu cukup.

| ID | Role | Langkah | Hasil yang diharapkan | Lolos |
|---|---|---|---|---|
| S8-01 | admin | Admin Sambas membuka daftar kunjungan | Hanya baris Sambas. Tidak ada baris Pontianak HQ | - [ ] |
| S8-02 | admin | Admin Sambas membuka detail atau approve kunjungan Pontianak HQ lewat URL langsung | Ditolak 403 | - [ ] |
| S8-03 | security | Pengawas Sambas memindai QR kunjungan Pontianak HQ di `/gate` | Ditolak dengan pesan lokasi tidak cocok | - [ ] |
| S8-04 | security | Pengawas Sambas membuka `/visits/[id]` milik Pontianak HQ lewat URL langsung | Ditolak 403 atau 404, tidak ada data bocor | - [ ] |
| S8-05 | vendor | vendor1a membuka daftar kunjungan | Hanya baris miliknya. Tidak ada baris vendor lain | - [ ] |
| S8-06 | vendor | Coba panggil approve atau check-in lewat tombol atau URL (bila terlihat) | Tidak ada tombol itu. Akses langsung ditolak 403 | - [ ] |

### Sesi 9. Perilaku jaringan buruk

| ID | Role | Langkah | Hasil yang diharapkan | Lolos |
|---|---|---|---|---|
| S9-01 | security | Di `/gate`, matikan internet lalu pindai QR atau klik Check-in | Ada pesan galat ramah di dalam popup, popup tetap terbuka, tombol Tutup tetap bisa dipakai setelah proses berhenti | - [ ] |
| S9-02 | vendor | Di `/visits/new`, isi form lalu putus internet sesaat sebelum Submit | Submit gagal dengan pesan jelas, isian tidak hilang, bisa ulangi setelah online | - [ ] |
| S9-03 | semua | Muat ulang halaman di tengah tunnel yang lambat | Tidak ada halaman putih permanen. Ada status muat atau pesan coba lagi | - [ ] |

## 6. OUT OF SCOPE (jangan file bug untuk ini)

1. `/{id}/feedback` dan `/{id}/incident`: placeholder Fase 2. BE 404 itu disengaja.
2. Pendaftaran vendor mandiri publik: tidak ada di MVP. Akun vendor dibuat manual oleh admin atau superadmin.
3. Layar Emergency Evacuation List terpisah: sudah diganti tab Sedang di Lokasi.
4. Tombol Approve, Reject, atau Check-in di tampilan vendor: memang tidak boleh ada.
5. Kasus API otomatis yang sudah ada di `docs/6. QA_CHECKLIST.md`: tidak perlu diulang di sini kecuali alur browsernya gagal.

## 7. Keanehan yang sudah diketahui (bukan bug)

- URL tunnel berubah tiap run. FE dan BE dapat URL acak yang berbeda. Selalu pakai pasangan sesi itu dan biarkan terminal tunnel terbuka.
- Peringatan websocket HMR di dev (`ws`, hot reload): tidak berbahaya selama halaman tetap bisa dimuat ulang.
- Presigned URL file berumur pendek. Kalau tautan file basi, muat ulang halaman detail untuk tautan baru sebelum lapor bug.
- Jam server menentukan jendela check-in +-2 jam. Selisih jam laptop dan server bisa membuat kasus batas terlihat gagal. Cocokkan jam dulu sebelum lapor.

## 8. Template laporan bug

Salin blok ini per temuan:

```text
Judul: [Role] ringkasan singkat, mis. [security] check-out gagal di /gate
Lingkungan: lokal / tunnel (tulis pasangan URL FE+BE sesi itu)
Akun: mis. security2a (Sambas)
URL: halaman persis tempat bug muncul
Langkah:
1.
2.
3.
Diharapkan:
Aktual (plus kode HTTP bila tahu):
Screenshot: lampirkan
Console: isi DevTools > Console dan tab Network yang merah
ID kasus: mis. S4-01 / S8-03
```

Kirim laporan dengan screenshot dan pesan console. Satu bug satu laporan. Jangan gabung temuan beda halaman dalam satu tiket.
