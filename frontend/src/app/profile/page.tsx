'use client'

import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { SecurityKioskShell } from '@/components/layouts/SecurityKioskShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { VendorMobileShell } from '@/components/layouts/VendorMobileShell'
import { ProfileBackLink } from '@/features/profile/components/ProfileBackLink'
import { ProfileForm } from '@/features/profile/components/ProfileForm'
import { usePendingApprovalCount } from '@/lib/api/hooks'
import { RequireAuth } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'

/**
 * `/profile` — "Profil Saya" untuk semua peran yang sudah masuk.
 *
 * Guard dan pemilihan shell mengikuti halaman terautentikasi lain
 * (`/dashboard`, `/visits/[id]`, `/qr`): `RequireAuth` menahan render sampai
 * sesi siap, lalu isi dibungkus shell milik peran pengguna — sidebar untuk
 * admin/superadmin, kiosk untuk security, bottom-nav untuk vendor. Tidak ada
 * logika shell baru di sini; shell tetap satu sumber kebenaran.
 */
export default function ProfilePage() {
  return (
    <RequireAuth>
      <ProfileScreen />
    </RequireAuth>
  )
}

function ProfileScreen() {
  const { user } = useSession()
  // Badge antrean hanya bermakna untuk shell yang menampilkannya
  // (admin/superadmin); peran lain tidak menembak query tambahan.
  const isApprover = user?.role === 'admin' || user?.role === 'super_admin'
  const { pendingCount } = usePendingApprovalCount(isApprover)

  if (user === null) {
    return null
  }

  const content = <ProfileForm />

  if (user.role === 'vendor') {
    return (
      <VendorMobileShell activeHref="/profile">
        {/* Wrapper geometri form (`max-w-2xl`) agar konten profil terpusat.
            Vendor TIDAK punya back link di badan halaman maupun di navbar —
            navigasi kembali sepenuhnya lewat bottom-nav. */}
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
          {content}
        </div>
      </VendorMobileShell>
    )
  }

  if (user.role === 'super_admin') {
    return (
      <SuperadminShell activeHref="/profile" pendingCount={pendingCount}>
        {content}
      </SuperadminShell>
    )
  }

  if (user.role === 'security') {
    return (
      <SecurityKioskShell>
        {/* Kembali ke SCR-05; wrapper `max-w-2xl` menyalin geometri form
            supaya panah kiri sejajar dengan judul "Profil Saya". */}
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
          <ProfileBackLink href="/gate" label="Gate Check-in" />
          {content}
        </div>
      </SecurityKioskShell>
    )
  }

  return (
    <AdminBranchShell activeHref="/profile" pendingCount={pendingCount}>
      {content}
    </AdminBranchShell>
  )
}
