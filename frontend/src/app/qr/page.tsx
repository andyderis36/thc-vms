'use client'

import { useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { QrCode } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { PicMobileShell } from '@/components/layouts/PicMobileShell'
import { useVisitsQuery } from '@/lib/api/hooks'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { RequireRole } from '@/lib/auth/guards'

/**
 * SCR-04 entry — "Tiket QR Aktif" milik Vendor/Mitra (desain 02-design-system §6.4).
 *
 * Halaman resolver (bukan daftar): memilih tiket paling relevan — sedang
 * `visiting`, lalu `approved`, lalu pengajuan terbaru — dan menggantikannya
 * ke `/visits/[id]` (kartu QR above-the-fold, AGENTS §6.5). Tanpa tiket sama
 * sekali → empty state jujur + ajakan mengajukan. Hanya peran `vendor`; peran
 * lain dipulangkan ke home-nya oleh `RequireRole`.
 */
export default function QrTicketPage() {
  return (
    <RequireRole allow={['vendor']}>
      <PicMobileShell activeHref="/qr">
        <QrResolver />
      </PicMobileShell>
    </RequireRole>
  )
}

function QrResolver() {
  const router = useRouter()
  const visitsQuery = useVisitsQuery({ limit: 50 })
  const items = useMemo(() => visitsQuery.data?.items ?? [], [visitsQuery.data])

  const active = useMemo(
    () =>
      items.find((visit) => visit.status === 'visiting') ??
      items.find((visit) => visit.status === 'approved') ??
      items[0] ??
      null,
    [items],
  )

  useEffect(() => {
    if (active !== null) {
      router.replace(`/visits/${active.id}`)
    }
  }, [active, router])

  if (visitsQuery.isPending || active !== null) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner size="lg" label="Mencari tiket aktif…" />
      </div>
    )
  }

  if (visitsQuery.isError) {
    return (
      <div className="card p-6">
        <p className="text-sm font-semibold text-danger-text">Gagal memuat tiket</p>
        <p className="mt-2 text-sm text-ink-secondary">{apiErrorMessage(visitsQuery.error)}</p>
        <Button variant="secondary" className="mt-4" onClick={() => void visitsQuery.refetch()}>
          Coba Lagi
        </Button>
      </div>
    )
  }

  return (
    <div className="card">
      <EmptyState
        icon={<QrCode aria-hidden="true" className="size-8" />}
        title="Belum ada tiket aktif"
        description="Tiket QR muncul di sini setelah pengajuan Anda disetujui."
      />
      <div className="flex justify-center pb-6">
        <Button onClick={() => router.push('/visits/new')}>Ajukan Kunjungan</Button>
      </div>
    </div>
  )
}
