'use client'

import type { ReactNode } from 'react'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { PicMobileShell } from '@/components/layouts/PicMobileShell'
import { VisitForm } from '@/features/visits/form/VisitForm'
import { RequireAuth } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'

/**
 * Pemilih shell berdasar peran sesi:
 * `pic` -> SHELL-04 (PicMobileShell), `super_admin`/`admin` -> SHELL-02
 * (AdminBranchShell). Peran lain tetap terlindungi `RequireAuth` tanpa
 * shell tambahan.
 */
function RoleShell({ children }: { children: ReactNode }) {
  const { user } = useSession()
  const role = user?.role ?? null

  if (role === 'pic') {
    return <PicMobileShell activeHref="/visits/new">{children}</PicMobileShell>
  }
  if (role === 'admin' || role === 'super_admin') {
    return (
      <AdminBranchShell activeHref="/visits/new">{children}</AdminBranchShell>
    )
  }
  return <>{children}</>
}

/** SCR-03 — Rute Formulir Pengajuan Kunjungan (`/visits/new`). */
export default function NewVisitPage() {
  return (
    <RequireAuth>
      <RoleShell>
        <VisitForm />
      </RoleShell>
    </RequireAuth>
  )
}
