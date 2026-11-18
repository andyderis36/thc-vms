'use client'

import { useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { QrCode } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { VendorMobileShell } from '@/components/layouts/VendorMobileShell'
import { qrResolverRefetchInterval, useVisitsQuery } from '@/lib/api/hooks'
import { queryKeys } from '@/lib/api/query-keys'
import type { VisitListParams, VisitListResult } from '@/lib/api/types'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { RequireRole } from '@/lib/auth/guards'
import { selectActiveQrVisit } from '@/lib/visits/active-qr-ticket'

/**
 * Params resolver tiket — konstanta modul agar kunci query yang dibaca dari
 * cache (untuk keputusan interval) identik dengan kunci yang di-subscribe hook.
 */
const QR_RESOLVER_PARAMS: VisitListParams = { limit: 50 }

/**
 * SCR-04 entry — "Tiket QR Aktif" milik Vendor/Mitra (desain 02-design-system 6.4).
 *
 * Halaman resolver (bukan daftar): memilih tiket yang BENAR-BENAR menampilkan
 * kartu QR — sedang `visiting`, lalu `offsite`, lalu `approved` — dan
 * menggantikannya ke
 * `/visits/[id]` (kartu QR above-the-fold, AGENTS 6.5). Kunjungan yang belum
 * disetujui TIDAK pernah dijadikan tujuan: tab "Tiket QR" akan berakhir
 * menyala sebagai "Kunjungan Saya" di halaman detail. Tanpa tiket aktif →
 * empty state jujur + ajakan mengajukan. Hanya peran `vendor`; peran lain
 * dipulangkan ke home-nya oleh `RequireRole`.
 */
export default function QrTicketPage() {
  return (
    <RequireRole allow={['vendor']}>
      <VendorMobileShell activeHref="/qr">
        <QrResolver />
      </VendorMobileShell>
    </RequireRole>
  )
}

function QrResolver() {
  const router = useRouter()
  const queryClient = useQueryClient()
  // Keputusan interval dibaca dari cache (pola yang sama dengan
  // `useVisitQrQuery` yang membaca status detail dari cache): mount pertama
  // cache kosong → poll 30 dtk (unresolved); begitu data mendarat, render
  // langganan membaca ulang cache terbaru → false saat tiket aktif terpilih
  // atau semua baris terminal. Satu observer pada satu kunci — membalik nilai
  // ini tidak pernah menciptakan timer ganda.
  const cachedItems =
    queryClient.getQueryData<VisitListResult>(
      queryKeys.visits.list(QR_RESOLVER_PARAMS),
    )?.items ?? []
  const visitsQuery = useVisitsQuery(
    QR_RESOLVER_PARAMS,
    true,
    qrResolverRefetchInterval(cachedItems),
  )
  const items = useMemo(() => visitsQuery.data?.items ?? [], [visitsQuery.data])

  const active = useMemo(() => selectActiveQrVisit(items), [items])

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
