# User Flow Antar-Layar – THC Visitor Management System (VMS)

Dokumen ini memetakan alur navigasi intuitif antara **5 Layar Inti MVP** berdasarkan operasional ISP THC.

---

## 1. Alur Navigasi Berdasarkan Peran

### 1.1 Alur THC Admin (Desktop / Mobile)
```text
SCR-01: Login Terpadu (Pilih Role: THC Admin)
  │
  ▼
SCR-02: Dashboard Kunjungan & Antrean Approval
  │
  ├──► Tab 'Menunggu Approval'  ──► Modal Approve / Reject (dengan Alasan)
  ├──► Tab 'Sedang di Lokasi'   ──► Monitor Teknisi yang Aktif di Cabang/POP
  ├──► Tombol 'Buat Kunjungan'  ──► SCR-03: Form Pengajuan Kunjungan
  └──► Klik Baris Kunjungan     ──► SCR-04: Detail & QR Kunjungan
                                       └──► Aksi: Reschedule / Cancel Kunjungan
```

### 1.2 Alur Petugas Jaga / Security (Tablet / Smartphone di Pos)
```text
SCR-01: Login Terpadu (Pilih Role: Security)
  │
  ▼
SCR-05: Layar Security Gate / Site Check-in
  │
  ├──► Scan QR / Cari Visit ID Teknisi
  │       │
  │       ├──► Verifikasi Identitas KTP/SIM
  │       └──► Klik 'Check-in' ──► Toast Sukses (Teknisi Masuk Status 'visiting')
  │                                └──► Refresh Antrean Gate (Tetap di SCR-05)
  │
  └──► Tab 'Sedang di Lokasi' ──► Klik 'Check-out' ──► Status Berubah 'completed'
```

### 1.3 Alur Vendor/Mitra - Teknisi (Mobile Smartphone di Jalan)
```text
SCR-01: Login Terpadu (Pilih Role: Vendor/Mitra)
  │
  ▼
SCR-02: Dashboard Kunjungan (Tampilan Terfilter: Hanya Kunjungan Milik Vendor/Mitra)
  │
  ├──► Klik 'Buat Kunjungan Baru' ──► SCR-03: Form Pengajuan Kunjungan
  │                                       │
  │                                       └──► Submit Sukses ──► Kembali ke SCR-02
  │
  └──► Klik Kartu Kunjungan       ──► SCR-04: Detail & QR Kunjungan
                                          ├──► Tampilkan QR Code Gerbang ke Petugas
                                          ├──► Ajukan Penjadwalan Ulang (Reschedule)
                                          └──► Batalkan Kunjungan (Cancel)
```

---

## 2. Alur End-to-End Operasional Lapangan (Happy Path)

```text
[Vendor/Mitra / Teknisi]         [THC Admin / NOC]              [Petugas Jaga Cabang/POP]
        │                              │                                  │
        ├── 1. Submit SCR-03 ─────────►│                                  │
        │   (Form Pengajuan POP)       │                                  │
        │                              ├── 2. Review di SCR-02 ──────────►│
        │                              │      (Klik Approve)              │
        │◄── 3. Terima QR Code ────────┤                                  │
        │   (Tampil di SCR-04 HP)      │                                  │
        │                              │                                  │
        ├── 4. Tiba di Cabang/POP ─────┼─────────────────────────────────►│
        │   (Tunjukkan QR di HP)       │                                  │
        │                              │                                  ├── 5. Scan di SCR-05
        │                              │                                  │      (Klik Check-in)
        │                              │◄── Monitor Live Status Visiting ─┤
        │                              │    di SCR-02 Dashboard Cabang    │
        │                              │                                  │
        ├── 6. Selesai Splicing/Maint ─┼─────────────────────────────────►│
        │                              │                                  ├── 7. Klik Check-out
        │                              │◄── Status Selesai (completed) ───┤
        ▼                              ▼                                  ▼
```
