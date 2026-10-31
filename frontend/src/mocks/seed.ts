/**
 * Dataset mock dev-only untuk MSW v2 (THC VMS frontend).
 *
 * Seluruh waktu dinamis diturunkan dari `Date.now()` saat modul dimuat agar
 * fixture toleransi check-in tetap bermakna setiap kali dev server dinyalakan.
 *
 * Larangan: jangan menambah field di luar kontrak `@/lib/api/types`
 * (tidak ada `code`, `check_in_at`, `created_by`, dsb.).
 */

import type { Location, Purpose, User, Vendor, VisitDetail } from '@/lib/api/types';

/** Password seragam seluruh akun demo (docs/5. LOCAL_DEV.md §6.1; sama dengan `DemoPassword` BE di `backend/seeds/seeddata/password.go` — JANGAN ubah nilainya). */
export const DEMO_PASSWORD = 'Password123!';

/** ID lokasi (bentuk UUID sesuai skema OpenAPI; nama manusia ada di `name`).
 * Nama konstanta LOC_* SENGAJA dipertahankan agar impor stabil (tanpa churn).
 * Pemetaan operasional Kalimantan Barat: LOC_SBY = Kantor Pusat Pontianak,
 * LOC_MLG = Cabang Sambas, LOC_SWJ = POP Mempawah, LOC_RKT = POP Singkawang,
 * LOC_LWG = miniPOP Aruk. Hanya string tampilan yang berubah. */
export const LOC_SBY = 'a11ce5b0-7f2d-4e5a-9c1d-0000000000a1';
export const LOC_MLG = 'b22df6c1-8e3e-4f6b-8d2e-0000000000b2';
export const LOC_SWJ = 'c33ea7d2-9f4f-4a7c-7e3f-0000000000c3';
export const LOC_RKT = 'd44fb8e3-0a50-4b8d-6f40-0000000000d4';
export const LOC_LWG = 'e55ac9f4-1b61-4c9e-5a51-0000000000e5';

/** ID tujuan kunjungan (bentuk UUID sesuai skema OpenAPI). */
export const PRP_SURVEY = 'f1010101-1a2b-4c3d-8e4f-000000000001';
export const PRP_OPS = 'f2020202-2b3c-4d4e-9f50-000000000002';
export const PRP_PROJECT = 'f3030303-3c4d-4e5f-8051-000000000003';
export const PRP_OTHER = 'f4040404-4d5e-4f50-9152-000000000004';

/** ID vendor mitra (bentuk UUID sesuai skema OpenAPI; `GET /vendors`). */
export const VND_LINTAS = 'e1000001-1a2b-4c3d-8e4f-000000000001';
export const VND_DAYA = 'e2000002-2b3c-4d4e-9f50-000000000002';

/** Nama vendor mitra — satu-satunya sumber nama untuk seed Vendor/Mitra. */
export const VND_LINTAS_NAME = 'PT Lintas Fiber';
export const VND_DAYA_NAME = 'PT Daya Power Mandiri';

const HOUR_MS = 3_600_000;

const isoHoursFromNow = (hours: number): string =>
  new Date(Date.now() + hours * HOUR_MS).toISOString();

export interface MockDb {
  users: User[];
  locations: Location[];
  purposes: Purpose[];
  vendors: Vendor[];
  visits: VisitDetail[];
}

/**
 * NIK demo 16 digit deterministik — SKEMA SAMA PERSIS dengan BE
 * (`demoNIK` di backend/seeds/seeddata): 3578{branch:02d}{role:02d}{seq:08d}
 * (admin = 01, vendor = 02). Nilai identik lintas BE/mock agar QA bisa
 * membandingkan langsung.
 */
function demoNik(branch: number, role: 1 | 2, seq: number): string {
  const branchPart = String(branch).padStart(2, '0');
  const rolePart = role === 1 ? '01' : '02';
  return `3578${branchPart}${rolePart}${String(seq).padStart(8, '0')}`;
}

/** ID user demo deterministik (`7d` = skema 26 akun; `7c` warisan 7 akun). */
function demoUserId(serial: number): string {
  return `c9b8a7d6-5e4f-4a3b-8c2d-2e0f9a8b7d${String(serial).padStart(2, '0')}`;
}

function buildSeed(): MockDb {
  const locations: Location[] = [
    {
      id: LOC_SBY,
      name: 'Kantor Pusat THC (Pontianak)',
      type: 'pusat',
      address: 'Jl. Ahmad Yani No. 45, Pontianak',
      city: 'Pontianak',
      timezone: 'WIB',
    },
    {
      id: LOC_MLG,
      name: 'Kantor Cabang Sambas',
      type: 'cabang',
      address: 'Jl. Sukaramai No. 12, Sambas',
      city: 'Sambas',
      timezone: 'WIB',
    },
    {
      id: LOC_SWJ,
      name: 'POP Mempawah',
      type: 'pop',
      address: 'Jl. Raden Kusno No. 8, Mempawah',
      city: 'Mempawah',
      timezone: 'WIB',
    },
    {
      id: LOC_RKT,
      name: 'POP Singkawang',
      type: 'pop',
      address: 'Jl. Pahlawan No. 22, Singkawang',
      city: 'Singkawang',
      timezone: 'WIB',
    },
    {
      id: LOC_LWG,
      name: 'miniPOP Aruk',
      type: 'minipop',
      address: 'Pos Lintas Batas Aruk, Sambas',
      city: 'Sambas',
      timezone: 'WIB',
    },
  ];

  const purposes: Purpose[] = [
    { id: PRP_SURVEY, name: 'Survey' },
    { id: PRP_OPS, name: 'Operation & Maintenance' },
    { id: PRP_PROJECT, name: 'Project' },
    { id: PRP_OTHER, name: 'Other' },
  ];

  const vendors: Vendor[] = [
    { id: VND_LINTAS, name: VND_LINTAS_NAME },
    { id: VND_DAYA, name: VND_DAYA_NAME },
  ];

  const vendorById = (id: string): string => {
    const found = vendors.find((vendor) => vendor.id === id);
    if (found === undefined) {
      throw new Error(`Vendor seed tidak ditemukan: ${id}`);
    }
    return found.name;
  };

  const locationNameById = (id: string): string => {
    const found = locations.find((loc) => loc.id === id);
    if (found === undefined) {
      throw new Error(`Lokasi seed tidak ditemukan: ${id}`);
    }
    return found.name;
  };

  /**
   * 26 akun demo skema baru (cermin kontrak BE paralel):
   * 1 superadmin + 5 admin (`admin1..5@transhybrid.net.id`) + 10 security
   * (`security{N}A/B@transhybrid.net.id`, N=1..5) + 10 Vendor/Mitra (`vendor{N}A/B@transhybrid.net.id`).
   * NIK 16 digit wajib untuk admin/vendor, `null` untuk security/superadmin
   * (BE menolak NIK untuk keduanya). Password semua = DEMO_PASSWORD.
   */
  const users: User[] = [
    {
      id: demoUserId(1),
      name: 'Hendra Wijaya',
      email: 'superadmin@transhybrid.net.id',
      phone: '0811-3000-001',
      nik: null,
      role: 'super_admin',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'internal',
      vendor_name: null,
      avatar_url: null,
    },
    ...[
      'Agus Setiawan (Admin Kantor Pusat Pontianak)',
      'Rina Kartika (Admin Cabang Sambas)',
      'Dedi Kurniawan (Admin POP Mempawah)',
      'Siti Rahayu (Admin POP Singkawang)',
      'Bambang Sutrisno (Admin miniPOP Aruk)',
    ].map(
      (name, index): User => {
        const locationId = [LOC_SBY, LOC_MLG, LOC_SWJ, LOC_RKT, LOC_LWG][index] as string;
        return {
          id: demoUserId(2 + index),
          name,
          email: `admin${index + 1}@transhybrid.net.id`,
          phone: `0811-3000-0${String(10 + index)}`,
          nik: demoNik(index + 1, 1, index + 1),
          role: 'admin',
          location_id: locationId,
          location_name: locationNameById(locationId),
          status: 'active',
          type: 'internal',
          vendor_name: null,
          avatar_url: null,
        };
      },
    ),
    ...[
      'Joko Susilo (Pengawas Kantor Pusat Pontianak)',
      'Sutrisno Hadi (Pengawas Kantor Pusat Pontianak)',
      'Rahmat Hidayat (Pengawas Cabang Sambas)',
      'Wahyu Saputra (Pengawas Cabang Sambas)',
      'Slamet Riyadi (Pengawas POP Mempawah)',
      'Andi Wijaya (Pengawas POP Mempawah)',
      'Herman Yusuf (Pengawas POP Singkawang)',
      'Tono Prasetyo (Pengawas POP Singkawang)',
      'Mulyadi Santoso (Pengawas miniPOP Aruk)',
      'Dadang Firmansyah (Pengawas miniPOP Aruk)',
    ].map((name, index): User => {
      // Pasangan A/B per cabang: N=1..5 → SBY/MLG/SWJ/RKT/LWG.
      const branch = Math.floor(index / 2);
      const variant = index % 2 === 0 ? 'a' : 'b';
      const locationId = [LOC_SBY, LOC_MLG, LOC_SWJ, LOC_RKT, LOC_LWG][branch] as string;
      return {
        id: demoUserId(7 + index),
        name,
        email: `security${branch + 1}${variant}@transhybrid.net.id`,
        phone: `0811-3000-0${String(20 + index)}`,
        nik: null,
        role: 'security',
        location_id: locationId,
        location_name: locationNameById(locationId),
        status: 'active',
        type: 'internal',
        vendor_name: null,
        avatar_url: null,
      };
    }),
    ...[
      'Dimas Prasetyo',
      'Eko Gunawan',
      'Fajar Nugroho',
      'Yoga Pratama',
      'Rudi Hartono',
      'Asep Saepudin',
      'Budi Santoso',
      'Irfan Maulana',
      'Hendra Saputra',
      'Teguh Laksmana',
    ].map((name, index): User => {
      // Varian A → PT Lintas Fiber, B → PT Daya Power Mandiri (cermin BE).
      const branch = Math.floor(index / 2);
      const variant = index % 2 === 0 ? 'a' : 'b';
      const vendorId = variant === 'a' ? VND_LINTAS : VND_DAYA;
      return {
        id: demoUserId(17 + index),
        name,
          email: `vendor${branch + 1}${variant}@transhybrid.net.id`,
          phone: `0812-4100-0${String(30 + index)}`,
          nik: demoNik(branch + 1, 2, index + 1),
        role: 'vendor',
        location_id: null,
        location_name: null,
        status: 'active',
        type: 'external',
        vendor_name: vendorById(vendorId),
        avatar_url: null,
      };
    }),
  ];

  const locationById = (id: string): Location => {
    const found = locations.find((loc) => loc.id === id);
    if (found === undefined) {
      throw new Error(`Lokasi seed tidak ditemukan: ${id}`);
    }
    return found;
  };

  const purposeById = (id: string): Purpose => {
    const found = purposes.find((purpose) => purpose.id === id);
    if (found === undefined) {
      throw new Error(`Purpose seed tidak ditemukan: ${id}`);
    }
    return found;
  };

  const userByEmail = (email: string): User => {
    const found = users.find((user) => user.email === email);
    if (found === undefined) {
      throw new Error(`User seed tidak ditemukan: ${email}`);
    }
    return found;
  };

  const vendorSplicing = userByEmail('vendor1a@transhybrid.net.id');
  const vendorGenset = userByEmail('vendor2a@transhybrid.net.id');

  const visits: VisitDetail[] = [
    {
      // Fixture toleransi: mulai 90 menit lagi -> check-in DIIZINKAN.
      id: 'd1e2f3a4-1001-4b5c-8d6e-000000000101',
      visit_id: 'VST-2026SBY001',
      status: 'approved',
      location: locationById(LOC_SBY),
      purposes: [purposeById(PRP_SURVEY)],
      vendor_user: vendorSplicing,
      vendor_name: 'PT Lintas Fiber',
      start_date: isoHoursFromNow(1.5),
      end_date: isoHoursFromNow(9.5),
      assignment_letter_url:
        'http://localhost:9000/thc-vms-bucket/assignment_letters/VST-2026SBY001/spk-splicing.pdf',
      notes: 'Splicing core FO ruas Darmo - Diponegoro.',
      visitors: [
        {
          name: 'Dimas Prasetyo',
          id_number: '3573010101900001',
          phone: '0812-4100-006',
          id_card_photo_url: null,
          vendor_id: VND_LINTAS,
          vendor_name: VND_LINTAS_NAME,
        },
        {
          name: 'Andi Kurniawan',
          id_number: '3573010202920002',
          phone: '0812-4100-016',
          id_card_photo_url: null,
          vendor_id: VND_DAYA,
          vendor_name: VND_DAYA_NAME,
        },
      ],
      created_at: isoHoursFromNow(-20),
    },
    {
      // Fixture toleransi: mulai 3 jam lagi -> check-in DITOLAK (di luar -2 jam).
      id: 'd1e2f3a4-1002-4b5c-8d6e-000000000102',
      visit_id: 'VST-2026MLG002',
      status: 'approved',
      location: locationById(LOC_MLG),
      purposes: [purposeById(PRP_OPS)],
      vendor_user: vendorGenset,
      vendor_name: 'PT Daya Power Mandiri',
      start_date: isoHoursFromNow(3),
      end_date: isoHoursFromNow(11),
      assignment_letter_url: null,
      notes: 'Uji beban genset dan penggantian aki UPS.',
      visitors: [
        {
          name: 'Eko Gunawan',
          id_number: '3573020303930003',
          phone: '0812-4200-007',
          id_card_photo_url: null,
        },
      ],
      created_at: isoHoursFromNow(-22),
    },
    {
      // Fixture toleransi: jendela sedang TERBUKA (mulai 2 jam lalu) -> happy path.
      id: 'd1e2f3a4-1003-4b5c-8d6e-000000000103',
      visit_id: 'VST-2026SBY003',
      status: 'approved',
      location: locationById(LOC_SBY),
      purposes: [purposeById(PRP_PROJECT), purposeById(PRP_OTHER)],
      vendor_user: vendorSplicing,
      vendor_name: 'PT Lintas Fiber',
      start_date: isoHoursFromNow(-2),
      end_date: isoHoursFromNow(6),
      assignment_letter_url: null,
      notes: 'Terminasi OLT dan cek suhu ruang server.',
      visitors: [
        {
          name: 'Dimas Prasetyo',
          id_number: '3573010101900001',
          phone: '0812-4100-006',
          id_card_photo_url: null,
        },
        {
          name: 'Rina Marlina',
          id_number: '3573010404940004',
          phone: '0812-4100-026',
          id_card_photo_url: null,
        },
        {
          name: 'Fajar Nugroho',
          id_number: '3573010505950005',
          phone: '0812-4100-036',
          id_card_photo_url: null,
        },
      ],
      created_at: isoHoursFromNow(-26),
    },
    {
      // Tab "Sedang di Lokasi" milik LOC_SBY.
      id: 'd1e2f3a4-1004-4b5c-8d6e-000000000104',
      visit_id: 'VST-2026SBY004',
      status: 'visiting',
      location: locationById(LOC_SBY),
      purposes: [purposeById(PRP_PROJECT)],
      vendor_user: vendorSplicing,
      vendor_name: 'PT Lintas Fiber',
      start_date: isoHoursFromNow(-3),
      end_date: isoHoursFromNow(5),
      assignment_letter_url: null,
      notes: 'Serah terima 20 unit ONT customer.',
      visitors: [
        {
          name: 'Dimas Prasetyo',
          id_number: '3573010101900001',
          phone: '0812-4100-006',
          id_card_photo_url: null,
        },
      ],
      created_at: isoHoursFromNow(-28),
    },
    {
      id: 'd1e2f3a4-1005-4b5c-8d6e-000000000105',
      visit_id: 'VST-2026SBY005',
      status: 'completed',
      location: locationById(LOC_SBY),
      purposes: [purposeById(PRP_OTHER)],
      vendor_user: vendorGenset,
      vendor_name: 'PT Daya Power Mandiri',
      start_date: isoHoursFromNow(-26),
      end_date: isoHoursFromNow(-18),
      assignment_letter_url: null,
      notes: 'Pembersihan rak dan uji sensor suhu selesai.',
      visitors: [
        {
          name: 'Eko Gunawan',
          id_number: '3573020303930003',
          phone: '0812-4200-007',
          id_card_photo_url: null,
        },
        {
          name: 'Sari Wulandari',
          id_number: '3573020606960006',
          phone: '0812-4200-017',
          id_card_photo_url: null,
        },
      ],
      created_at: isoHoursFromNow(-50),
    },
    {
      id: 'd1e2f3a4-1006-4b5c-8d6e-000000000106',
      visit_id: 'VST-2026SWJ006',
      status: 'requested',
      location: locationById(LOC_SWJ),
      purposes: [purposeById(PRP_SURVEY)],
      vendor_user: vendorGenset,
      vendor_name: 'PT Daya Power Mandiri',
      start_date: isoHoursFromNow(26),
      end_date: isoHoursFromNow(34),
      assignment_letter_url: null,
      notes: 'Menunggu persetujuan admin cabang.',
      visitors: [
        {
          name: 'Eko Gunawan',
          id_number: '3573020303930003',
          phone: '0812-4200-007',
          id_card_photo_url: null,
        },
      ],
      created_at: isoHoursFromNow(-4),
    },
    {
      id: 'd1e2f3a4-1007-4b5c-8d6e-000000000107',
      visit_id: 'VST-2026MLG007',
      status: 'rejected',
      location: locationById(LOC_MLG),
      purposes: [purposeById(PRP_SURVEY)],
      vendor_user: vendorSplicing,
      vendor_name: 'PT Lintas Fiber',
      start_date: isoHoursFromNow(30),
      end_date: isoHoursFromNow(38),
      assignment_letter_url: null,
      notes:
        'Ditolak: jadwal bentrok dengan maintenance terjadwal core router. Silakan ajukan ulang di tanggal lain.',
      visitors: [
        {
          name: 'Dimas Prasetyo',
          id_number: '3573010101900001',
          phone: '0812-4100-006',
          id_card_photo_url: null,
        },
      ],
      created_at: isoHoursFromNow(-30),
    },
    {
      id: 'd1e2f3a4-1008-4b5c-8d6e-000000000108',
      visit_id: 'VST-2026SBY008',
      status: 'cancelled',
      location: locationById(LOC_SBY),
      purposes: [purposeById(PRP_PROJECT)],
      vendor_user: vendorGenset,
      vendor_name: 'PT Daya Power Mandiri',
      start_date: isoHoursFromNow(-50),
      end_date: isoHoursFromNow(-42),
      assignment_letter_url: null,
      notes: 'Dibatalkan oleh vendor karena perangkat belum tersedia.',
      visitors: [
        {
          name: 'Eko Gunawan',
          id_number: '3573020303930003',
          phone: '0812-4200-007',
          id_card_photo_url: null,
        },
      ],
      created_at: isoHoursFromNow(-72),
    },
    {
      id: 'd1e2f3a4-1009-4b5c-8d6e-000000000109',
      visit_id: 'VST-2026RKT009',
      status: 'rescheduled',
      location: locationById(LOC_RKT),
      purposes: [purposeById(PRP_PROJECT)],
      vendor_user: vendorSplicing,
      vendor_name: 'PT Lintas Fiber',
      start_date: isoHoursFromNow(50),
      end_date: isoHoursFromNow(58),
      assignment_letter_url: null,
      notes: 'Dijadwalkan ulang atas permintaan vendor: menunggu modul SFP tiba.',
      visitors: [
        {
          name: 'Dimas Prasetyo',
          id_number: '3573010101900001',
          phone: '0812-4100-006',
          id_card_photo_url: null,
        },
        {
          name: 'Andi Kurniawan',
          id_number: '3573010202920002',
          phone: '0812-4100-016',
          id_card_photo_url: null,
        },
      ],
      created_at: isoHoursFromNow(-48),
    },
    {
      id: 'd1e2f3a4-1010-4b5c-8d6e-000000000110',
      visit_id: 'VST-2026LWG010',
      status: 'not_visit',
      location: locationById(LOC_LWG),
      purposes: [purposeById(PRP_SURVEY)],
      vendor_user: vendorGenset,
      vendor_name: 'PT Daya Power Mandiri',
      start_date: isoHoursFromNow(-72),
      end_date: isoHoursFromNow(-64),
      assignment_letter_url: null,
      notes: 'Tamu tidak hadir pada jadwal yang disetujui.',
      visitors: [
        {
          name: 'Eko Gunawan',
          id_number: '3573020303930003',
          phone: '0812-4200-007',
          id_card_photo_url: null,
        },
      ],
      created_at: isoHoursFromNow(-96),
    },
  ];

  return { users, locations, purposes, vendors, visits };
}

/** Database mock yang bisa dimutasi handler; di-reset agar pengujian berulang. */
export const db: MockDb = buildSeed();

/** Kembalikan `db` ke isi seed awal (waktu dinamis dihitung ulang dari sekarang). */
export function resetDb(): void {
  const fresh = buildSeed();
  db.users = fresh.users;
  db.locations = fresh.locations;
  db.purposes = fresh.purposes;
  db.vendors = fresh.vendors;
  db.visits = fresh.visits;
}
