'use client'

import { use } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { VendorMobileShell } from '@/components/layouts/VendorMobileShell'
import { SecurityKioskShell } from '@/components/layouts/SecurityKioskShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { RequireAuth } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import { useVisitLogsQuery, useVisitQuery } from '@/lib/api/hooks'
import type { Role } from '@/lib/api/types'
import { VisitLogsTimeline } from '../VisitLogsTimeline'

interface RiwayatPageProps {
  params: Promise<{ id: string }>
}

export default function VisitRiwayatPage({ params }: RiwayatPageProps) {
  const { id } = use(params)

  return (
    <RequireAuth>
      <RiwayatScreen visitId={id} />
    </RequireAuth>
  )
}

function RiwayatScreen({ visitId }: { visitId: string }) {
  const { user } = useSession()
  const role: Role | null = user !== null ? user.role : null
  const visitQuery = useVisitQuery(visitId)
  const logsQuery = useVisitLogsQuery(visitId)
  const visit = visitQuery.data

  const backHref = `/visits/${visitId}`
  const content = visitQuery.isPending ? (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner size="lg" label="Memuat riwayat kunjungan…" />
    </div>
  ) : visitQuery.isError || visit === undefined ? (
    <Card>
      <EmptyState
        title="Kunjungan tidak ditemukan"
        description="Kunjungan yang Anda cari tidak ada atau tidak berada dalam lingkup akses Anda."
        action={
          <Link
            href="/dashboard"
            className="inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-brand px-4 text-xs font-semibold uppercase tracking-wide text-brand"
          >
            Kembali ke Dashboard
          </Link>
        }
      />
    </Card>
  ) : (
    <>
      <div className="mb-4">
        <Link
          href={backHref}
          className="inline-flex min-h-touch items-center gap-2 rounded-control px-4 text-xs font-semibold uppercase tracking-wide text-ink-secondary transition duration-150 hover:bg-neutral-bg active:bg-ink/10"
        >
          <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
          Kembali ke Detail {visit.visit_id}
        </Link>
      </div>
      <VisitLogsTimeline
        visitId={visitId}
        logs={logsQuery.data ?? []}
        isPending={logsQuery.isPending}
        isError={logsQuery.isError}
        onRetry={() => void logsQuery.refetch()}
        before={visit.work_photos?.before ?? null}
        after={visit.work_photos?.after ?? null}
        limit={null}
        hideViewAllLink
      />
    </>
  )

  if (role === null) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner size="lg" label="Memuat riwayat kunjungan…" />
      </div>
    )
  }

  switch (role) {
    case 'vendor':
      return (
        <VendorMobileShell activeHref={backHref} visitStatus={visit?.status}>
          {content}
        </VendorMobileShell>
      )
    case 'admin':
      return <AdminBranchShell activeHref={backHref}>{content}</AdminBranchShell>
    case 'security':
      return <SecurityKioskShell>{content}</SecurityKioskShell>
    case 'super_admin':
    case 'dev-superadmin':
      return <SuperadminShell activeHref={backHref}>{content}</SuperadminShell>
  }
}
