import { getRoleLabel } from '@/lib/auth/capabilities'

/** Pasangan label per tujuan navigasi: desktop (sidebar) & mobile (bottom nav). */
export interface NavLabel {
  /** Label desktop — panjang; SAMA untuk semua role pada tujuan yang sama. */
  readonly desktop: string
  /** Label mobile — ringkas; SAMA untuk semua role pada tujuan yang sama. */
  readonly mobile: string
}

/**
 * SATU-SATUNYA sumber kebenaran label menu app shell — dipakai bersama oleh
 * SHELL-01 (`SuperadminShell`) dan SHELL-02 (`AdminBranchShell`), sehingga
 * tujuan navigasi yang sama selalu tampil dengan nama yang sama di mata
 * pengguna, berapa pun role-nya (konsistensi label §6.1/§6.2).
 *
 * - `desktop`: label panjang untuk sidebar (>= 1024px).
 * - `mobile`: label pendek untuk BottomNav (< 1024px).
 * - Label peran memakai `getRoleLabel` sehingga otomatis sinkron dengan
 *   teks peran lain di seluruh frontend (mis. "Pengawas").
 *
 * Jangan menaruh teks menu literal di shell — tambah/ubah kunci di sini saja.
 */
export const NAV_LABELS = {
  /** `/dashboard` — SCR-02 lintas cabang (superadmin) & monitoring cabang (admin). */
  dashboard: { desktop: 'Dashboard', mobile: 'Dashboard' },
  /** `/approvals` — antrean persetujuan milik role tersebut (badge counter). */
  approvals: { desktop: 'Antrean Approval', mobile: 'Approval' },
  /** `/facilities` — daftar cabang/POP/miniPOP; hanya SHELL-01 (superadmin). */
  facilities: { desktop: 'Fasilitas', mobile: 'Fasilitas' },
  /** `/security` — panel kelola satpam/pengawas; kedua role. */
  security: { desktop: getRoleLabel('security'), mobile: getRoleLabel('security') },
  /** `/users` — manajemen admin cabang & mitra vendor; hanya SHELL-01. */
  users: { desktop: 'Users', mobile: 'Users' },
  /** `/gate` — konsol SCR-05; item SHELL-02, bernaung di alias Dashboard SHELL-01. */
  gate: { desktop: 'Pos Check-in Gerbang', mobile: 'Check-in' },
  /** `/visits/new` — SCR-03; item desktop SHELL-02 (tak punya tab mobile). */
  createVisit: { desktop: 'Buat Kunjungan Baru', mobile: 'Buat Kunjungan' },
} satisfies Record<string, NavLabel>
