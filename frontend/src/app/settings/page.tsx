'use client'

import Link from 'next/link'
import { BellRing, Mail, ServerCog } from 'lucide-react'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Card, CardBody } from '@/components/ui/Card'
import { ProfileBackLink } from '@/features/profile/components/ProfileBackLink'
import { RequireRole, useRequireRole } from '@/lib/auth/guards'
import { usePendingApprovalCount } from '@/lib/api/hooks'

/**
 * Hub Pengaturan (`/settings`) — daftar submenu pengaturan, dibuka dari item
 * "Pengaturan" di menu profil (bukan sidebar). Kartu Sistem hanya untuk
 * dev-superadmin; kartu Notifikasi untuk super_admin dan dev-superadmin.
 * Telemetri mailer (antrean, dropped, kirim email tes) tinggal di Log Email.
 */
export default function SettingsHubPage() {
  return (
    <RequireRole allow={['super_admin']}>
      <SettingsHubScreen />
    </RequireRole>
  )
}

function SettingsHubScreen() {
  const { pendingCount = 0 } = usePendingApprovalCount() ?? {}
  const devRole = useRequireRole(['dev-superadmin'])

  return (
    <SuperadminShell pendingCount={pendingCount}>
      <ProfileBackLink href="/dashboard" label="Dashboard" />
      <div className="mb-5 mt-3 min-w-0">
        <h1 className="text-xl font-bold text-ink">Pengaturan</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Kelola preferensi aplikasi dan telemetri platform.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/settings/notifications"
          className="rounded-card border border-border-light bg-surface p-5 transition hover:border-brand hover:bg-brand-soft/40"
        >
          <span className="flex size-9 items-center justify-center rounded-control bg-brand-soft text-brand">
            <BellRing aria-hidden="true" className="size-4 shrink-0" />
          </span>
          <span className="mt-3 block text-base font-semibold text-ink">Notifikasi</span>
          <span className="mt-1 block text-sm text-ink-secondary">
            Atur kanal notifikasi per peristiwa dan baris wajib sistem.
          </span>
        </Link>

        {devRole !== null ? (
          <Link
            href="/settings/system"
            className="rounded-card border border-border-light bg-surface p-5 transition hover:border-brand hover:bg-brand-soft/40"
          >
            <span className="flex size-9 items-center justify-center rounded-control bg-brand-soft text-brand">
              <ServerCog aria-hidden="true" className="size-4 shrink-0" />
            </span>
            <span className="mt-3 block text-base font-semibold text-ink">Sistem</span>
            <span className="mt-1 block text-sm text-ink-secondary">
              Versi migrasi database vs repositori.
            </span>
          </Link>
        ) : null}

        <Link
          href="/settings/mail-logs"
          className="rounded-card border border-border-light bg-surface p-5 transition hover:border-brand hover:bg-brand-soft/40"
        >
          <span className="flex size-9 items-center justify-center rounded-control bg-brand-soft text-brand">
            <Mail aria-hidden="true" className="size-4 shrink-0" />
          </span>
          <span className="mt-3 block text-base font-semibold text-ink">Log Email</span>
          <span className="mt-1 block text-sm text-ink-secondary">
            Riwayat pengiriman email notifikasi ...
          </span>
        </Link>
      </div>

      <Card className="mt-4">
        <CardBody>
          <p className="text-sm text-ink-secondary">
            Perubahan pengaturan dicatat di Jejak Audit.
          </p>
        </CardBody>
      </Card>
    </SuperadminShell>
  )
}
