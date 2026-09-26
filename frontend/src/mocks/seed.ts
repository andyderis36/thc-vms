/**
 * Dataset mock dev-only untuk MSW v2 (THC VMS frontend).
 *
 * Seluruh waktu dinamis diturunkan dari `Date.now()` saat modul dimuat agar
 * fixture toleransi check-in tetap bermakna setiap kali dev server dinyalakan.
 *
 * Larangan: jangan menambah field di luar kontrak `@/lib/api/types`
 * (tidak ada `code`, `check_in_at`, `created_by`, dsb.).
 */

import type { Location, Purpose, User, VisitDetail } from '@/lib/api/types';

/** Password seragam seluruh akun demo (docs/5. LOCAL_DEV.md §6.1). */
export const DEMO_PASSWORD = 'Password123!';

/** ID lokasi (bentuk UUID sesuai skema OpenAPI; nama manusia ada di `name`). */
export const LOC_SBY = 'a11ce5b0-7f2d-4e5a-9c1d-0000000000a1';
export const LOC_MLG = 'b22df6c1-8e3e-4f6b-8d2e-0000000000b2';
export const LOC_SWJ = 'c33ea7d2-9f4f-4a7c-7e3f-0000000000c3';
export const LOC_RKT = 'd44fb8e3-0a50-4b8d-6f40-0000000000d4';
export const LOC_LWG = 'e55ac9f4-1b61-4c9e-5a51-0000000000e5';

/** ID tujuan kunjungan (bentuk UUID sesuai skema OpenAPI). */
export const PRP_SPLICING = 'f1010101-1a2b-4c3d-8e4f-000000000001';
export const PRP_GENSET = 'f2020202-2b3c-4d4e-9f50-000000000002';
export const PRP_SERVER = 'f3030303-3c4d-4e5f-8051-000000000003';
export const PRP_PREVENTIVE = 'f4040404-4d5e-4f50-9152-000000000004';
export const PRP_LOGISTICS = 'f5050505-5e6f-4051-a253-000000000005';
export const PRP_AUDIT = 'f6060606-6f70-4162-b364-000000000006';

const HOUR_MS = 3_600_000;

const isoHoursFromNow = (hours: number): string =>
  new Date(Date.now() + hours * HOUR_MS).toISOString();

export interface MockDb {
  users: User[];
  locations: Location[];
  purposes: Purpose[];
  visits: VisitDetail[];
}

function buildSeed(): MockDb {
  const locations: Location[] = [
    {
      id: LOC_SBY,
      name: 'Kantor Pusat THC (Surabaya)',
      type: 'pusat',
      address: 'Jl. Raya Darmo No. 45, Surabaya',
      city: 'Surabaya',
      timezone: 'WIB',
    },
    {
      id: LOC_MLG,
      name: 'Kantor Cabang Malang',
      type: 'cabang',
      address: 'Jl. Ijen No. 12, Malang',
      city: 'Malang',
      timezone: 'WIB',
    },
    {
      id: LOC_SWJ,
      name: 'POP Sawojajar',
      type: 'pop',
      address: 'Ruko Sawojajar Blok A-4, Malang',
      city: 'Malang',
      timezone: 'WIB',
    },
    {
      id: LOC_RKT,
      name: 'POP Rungkut Industri',
      type: 'pop',
      address: 'Kawasan SIER Rungkut Kav. 9, Surabaya',
      city: 'Surabaya',
      timezone: 'WIB',
    },
    {
      id: LOC_LWG,
      name: 'miniPOP Lawang',
      type: 'minipop',
      address: 'Shelter Tower THC Lawang, Malang',
      city: 'Malang',
      timezone: 'WIB',
    },
  ];

  const purposes: Purpose[] = [
    { id: PRP_SPLICING, name: 'Splicing & Maintenance Kabel Fiber Optik' },
    { id: PRP_GENSET, name: 'Maintenance Genset & Sistem Catu Daya UPS' },
    { id: PRP_SERVER, name: 'Troubleshooting Perangkat Server & Router ISP' },
    { id: PRP_PREVENTIVE, name: 'Preventive Maintenance & Kebersihan Shelter' },
    { id: PRP_LOGISTICS, name: 'Pengantaran / Penarikan Perangkat & Sparepart' },
    { id: PRP_AUDIT, name: 'Survey Jalur / Audit Infrastruktur' },
  ];

  const users: User[] = [
    {
      id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c01',
      name: 'Hendra Wijaya',
      email: 'superadmin@thc.net.id',
      phone: '0811-3000-001',
      role: 'super_admin',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'internal',
      vendor_name: null,
    },
    {
      id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c02',
      name: 'Bayu Santoso',
      email: 'admin.sby@thc.net.id',
      phone: '0811-3000-002',
      role: 'admin',
      location_id: LOC_SBY,
      location_name: 'Kantor Pusat THC (Surabaya)',
      status: 'active',
      type: 'internal',
      vendor_name: null,
    },
    {
      id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c03',
      name: 'Dian Permata',
      email: 'admin.mlg@thc.net.id',
      phone: '0811-3000-003',
      role: 'admin',
      location_id: LOC_MLG,
      location_name: 'Kantor Cabang Malang',
      status: 'active',
      type: 'internal',
      vendor_name: null,
    },
    {
      id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c04',
      name: 'Joko Susilo',
      email: 'satpam.sby@thc.net.id',
      phone: '0811-3000-004',
      role: 'security',
      location_id: LOC_SBY,
      location_name: 'Kantor Pusat THC (Surabaya)',
      status: 'active',
      type: 'internal',
      vendor_name: null,
    },
    {
      id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c05',
      name: 'Rahmat Hidayat',
      email: 'satpam.sawojajar@thc.net.id',
      phone: '0811-3000-005',
      role: 'security',
      location_id: LOC_SWJ,
      location_name: 'POP Sawojajar',
      status: 'active',
      type: 'internal',
      vendor_name: null,
    },
    {
      id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c06',
      name: 'Dimas Prasetyo',
      email: 'vendor.splicing@mitra-fo.com',
      phone: '0812-4100-006',
      role: 'pic',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'external',
      vendor_name: 'PT Lintas Fiber',
    },
    {
      id: 'c9b8a7d6-5e4f-4a3b-8c2d-1e0f9a8b7c07',
      name: 'Eko Gunawan',
      email: 'vendor.genset@dayapower.co.id',
      phone: '0812-4200-007',
      role: 'pic',
      location_id: null,
      location_name: null,
      status: 'active',
      type: 'external',
      vendor_name: 'PT Daya Power Mandiri',
    },
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

  const picSplicing = userByEmail('vendor.splicing@mitra-fo.com');
  const picGenset = userByEmail('vendor.genset@dayapower.co.id');

  const visits: VisitDetail[] = [
    {
      // Fixture toleransi: mulai 90 menit lagi -> check-in DIIZINKAN.
      id: 'd1e2f3a4-1001-4b5c-8d6e-000000000101',
      visit_id: 'VST-2026SBY001',
      status: 'approved',
      location: locationById(LOC_SBY),
      purposes: [purposeById(PRP_SPLICING)],
      pic_user: picSplicing,
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
        },
        {
          name: 'Andi Kurniawan',
          id_number: '3573010202920002',
          phone: '0812-4100-016',
          id_card_photo_url: null,
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
      purposes: [purposeById(PRP_GENSET)],
      pic_user: picGenset,
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
      purposes: [purposeById(PRP_SERVER), purposeById(PRP_PREVENTIVE)],
      pic_user: picSplicing,
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
      purposes: [purposeById(PRP_LOGISTICS)],
      pic_user: picSplicing,
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
      purposes: [purposeById(PRP_PREVENTIVE)],
      pic_user: picGenset,
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
      purposes: [purposeById(PRP_SPLICING)],
      pic_user: picGenset,
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
      purposes: [purposeById(PRP_AUDIT)],
      pic_user: picSplicing,
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
      purposes: [purposeById(PRP_LOGISTICS)],
      pic_user: picGenset,
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
      purposes: [purposeById(PRP_SERVER)],
      pic_user: picSplicing,
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
      purposes: [purposeById(PRP_AUDIT)],
      pic_user: picGenset,
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

  return { users, locations, purposes, visits };
}

/** Database mock yang bisa dimutasi handler; di-reset agar pengujian berulang. */
export const db: MockDb = buildSeed();

/** Kembalikan `db` ke isi seed awal (waktu dinamis dihitung ulang dari sekarang). */
export function resetDb(): void {
  const fresh = buildSeed();
  db.users = fresh.users;
  db.locations = fresh.locations;
  db.purposes = fresh.purposes;
  db.visits = fresh.visits;
}
