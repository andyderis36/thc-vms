'use client'

import { AlertTriangle } from 'lucide-react'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { ProfileBackLink } from '@/features/profile/components/ProfileBackLink'
import { RequireRole } from '@/lib/auth/guards'
import {
  usePendingApprovalCount,
  useSystemSettingsQuery,
} from '@/lib/api/hooks'

export default function SettingsSystemPage() {
  return (
    <RequireRole allow={['dev-superadmin']}>
      <SettingsSystemScreen />
    </RequireRole>
  )
}

function SettingsSystemScreen() {
  const { pendingCount = 0 } = usePendingApprovalCount() ?? {}
  const systemQuery = useSystemSettingsQuery() as {
    data?: {
      dbVersion?: number | null
      db_version?: number | null
      repoVersion?: number
      repo_version?: number
      inSync?: boolean
      in_sync?: boolean
    } | null
    isPending: boolean
    isError: boolean
    error: unknown
    refetch: () => void | Promise<unknown>
  }

  return (
    <SuperadminShell pendingCount={pendingCount}>
      <ProfileBackLink href="/settings" label="Pengaturan" />
      <div className="mb-5 mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-ink">Sistem</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Versi migrasi database yang sudah diterapkan vs versi yang diharapkan repositori.
          </p>
        </div>
      </div>

      {systemQuery.isPending ? (
          <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat pengaturan sistem.
          </div>
      ) : systemQuery.isError ? (
        <div className="card p-6">
          <EmptyState
            icon={<AlertTriangle aria-hidden="true" className="size-8" />}
            title="Tidak dapat memuat pengaturan sistem"
            description="Periksa koneksi atau izin akses Anda."
          />
          <Button variant="secondary" className="mt-4 min-h-touch" onClick={() => void systemQuery.refetch()}>
            Coba Lagi
          </Button>
        </div>
      ) : (
        <div className="card p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-control border border-border-light p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Versi Database</p>
              <p className="mt-1 text-2xl font-bold text-ink">
                {systemQuery.data?.dbVersion ?? systemQuery.data?.db_version ?? '—'}
              </p>
            </div>
            <div className="rounded-control border border-border-light p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Versi Repositori</p>
              <p className="mt-1 text-2xl font-bold text-ink">
                {systemQuery.data?.repoVersion ?? systemQuery.data?.repo_version ?? '—'}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">Status sinkronisasi migrasi:</span>
            {systemQuery.data?.inSync ?? systemQuery.data?.in_sync ? (
              <Badge tone="success" className="rounded-badge">Sinkron</Badge>
            ) : (
              <Badge tone="danger" className="rounded-badge">Tidak sinkron</Badge>
            )}
          </div>
        </div>
      )}

    </SuperadminShell>
  )
}
