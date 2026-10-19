'use client'

import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Spinner } from '@/components/ui/Spinner'
import { SecurityUserPanel } from '@/features/security/components/SecurityUserModal'
import { usePendingApprovalCount } from '@/lib/api/hooks'
import type { Role } from '@/lib/api/types'
import { RequireRole } from '@/lib/auth/guards'
import { getRoleLabel } from '@/lib/auth/capabilities'
import { useSession } from '@/lib/auth/session'

/**
 * Halaman mandiri Kelola Pengawas — versi halaman dari `SecurityUserPanel`
 * (satu komponen, dipakai juga modal dashboard: DRY). `super_admin`
 * memilih cabang; `admin` terkunci ke cabangnya. Guard rute +
 * guard kapabilitas ganda menolak Vendor/Mitra/security.
 */
export default function SecurityPage() {
  return (
    <RequireRole allow={['super_admin', 'admin']}>
      <SecurityScreen />
    </RequireRole>
  )
}

function RoleShell({ role, pendingCount, children }: { role: Role; pendingCount: number; children: React.ReactNode }) {
  if (role === 'super_admin') {
    return (
      <SuperadminShell pendingCount={pendingCount} activeHref="/security">
        {children}
      </SuperadminShell>
    )
  }
  return (
    <AdminBranchShell pendingCount={pendingCount} activeHref="/security">
      {children}
    </AdminBranchShell>
  )
}

function SecurityScreen() {
  const { user } = useSession()
  const role = user !== null ? user.role : null

  // Badge antrean shell: total requested + rescheduled (server-total,
  // limit 1 — hanya total yang dipakai); lihat usePendingApprovalCount.
  const { pendingCount } = usePendingApprovalCount()

  if (role === null) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner size="lg" label={`Memuat data ${getRoleLabel('security').toLowerCase()}…`} />
      </div>
    )
  }

  return (
    <RoleShell role={role} pendingCount={pendingCount}>
      {/*
        Kepala halaman memakai skala & ritme yang SAMA dengan dashboard &
        approvals (h1 `text-2xl tracking-tight`, subjudul `mt-1.5`) supaya
        berpindah antar halaman back-office tidak terasa melompat.
      */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            {`Kelola ${getRoleLabel('security')}`}
          </h1>
          <p className="mt-1.5 text-sm text-ink-secondary">
            {`Daftarkan akun ${getRoleLabel('security').toLowerCase()} baru dan kelola status aktif/nonaktif.`}
          </p>
        </div>
      </div>

      {/*
        TIDAK ada pembungkus `.card` di sini: `SecurityUserPanel` sudah
        memancarkan kartunya sendiri (tumpukan < 768px, kartu 2 kolom
        768-1023px, tabel desktop >= 1024px — prop `variant="page"`).
        Membungkusnya kartu lagi menghasilkan kotak berborder di dalam
        kotak berbordered. Pola yang sama dipakai dashboard/approvals —
        kartu hasil berada langsung di atas latar halaman.
      */}
      <SecurityUserPanel enabled variant="page" onCreated={() => undefined} />
    </RoleShell>
  )
}
