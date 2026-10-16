'use client'

import type { ReactNode } from 'react'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { PicMobileShell } from '@/components/layouts/PicMobileShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { VisitForm } from '@/features/visits/form/VisitForm'
import { RequireRole } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import { usePendingApprovalCount } from '@/lib/api/hooks'

/**
 * Pemilih shell berdasar peran sesi — SETIAP peran memakai shellnya sendiri
 * (superadmin = gelap + switcher, admin = putih terkunci, vendor = mobile):
 * `vendor` -> SHELL-04 (PicMobileShell), `super_admin` -> SHELL-01
 * (SuperadminShell), `admin` -> SHELL-02 (AdminBranchShell). Guard
 * `RequireRole` di bawah sudah menahan `security`.
 */
function RoleShell({ children }: { children: ReactNode }) {
  const { user } = useSession()
  const role = user?.role ?? null
  // Badge antrean shell: requested + rescheduled (server-total, limit 1) —
  // keduanya menunggu keputusan; lihat usePendingApprovalCount.
  const { pendingCount } = usePendingApprovalCount()

  if (role === 'vendor') {
    return <PicMobileShell activeHref="/visits/new">{children}</PicMobileShell>
  }
  if (role === 'super_admin') {
    return (
      <SuperadminShell activeHref="/visits/new" pendingCount={pendingCount}>
        {children}
      </SuperadminShell>
    )
  }
  return (
    <AdminBranchShell activeHref="/visits/new" pendingCount={pendingCount}>
      {children}
    </AdminBranchShell>
  )
}

/**
 * SCR-03 — Rute Formulir Pengajuan Kunjungan (`/visits/new`).
 *
 * PRD §4: hanya `vendor`, `admin`, `super_admin` boleh mengajukan. `security`
 * ditolak ke home-nya (`/gate`) oleh `RequireRole` — tidak pernah melihat form.
 */
export default function NewVisitPage() {
  return (
    <RequireRole allow={['vendor', 'admin', 'super_admin']}>
      <RoleShell>
        <VisitForm />
      </RoleShell>
    </RequireRole>
  )
}
