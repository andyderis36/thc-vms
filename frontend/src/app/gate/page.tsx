'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { SecurityKioskShell, type KioskTabId } from '@/components/layouts/SecurityKioskShell'
import { RequireRole } from '@/lib/auth/guards'
import { useCheckInVisitMutation, useCheckOutVisitMutation, useVisitsQuery } from '@/lib/api/hooks'
import type { VisitDetail, VisitStatus } from '@/lib/api/types'
import { ScannerPanel, type ScanPhase } from '@/features/gate/ScannerPanel'
import { GateQueue } from '@/features/gate/GateQueue'

/** Peta tab gerbang -> status kunjungan yang queried dari API. */
const TAB_STATUS: Record<KioskTabId, VisitStatus> = {
  upcoming: 'approved',
  'on-site': 'visiting',
  completed: 'completed',
}

/**
 * SCR-05 - Security Gate / Site Check-in.
 *
 * Hanya `security` dan `admin` (dual-role check-in). Satu guard `RequireRole`
 * cukup: ia sudah menolak unauthenticated (-> /login atau /login?expired=1)
 * dan memulangkan PIC ke home route-nya. Tanpa nesting RequireAuth ganda.
 */
export default function GatePage() {
  return (
    <RequireRole allow={['security', 'admin']}>
      <GateContent />
    </RequireRole>
  )
}

/**
 * Isi gerbang dipisah agar hook data (useVisitsQuery) hanya jalan setelah
 * guard lolos — tidak menembak API saat sesi masih loading/unauthenticated.
 */
function GateContent() {
  const [tab, setTab] = useState<KioskTabId>('upcoming')
  const [phase, setPhase] = useState<ScanPhase>({ phase: 'idle' })
  const [pendingVisitId, setPendingVisitId] = useState<string | null>(null)

  const visitsQuery = useVisitsQuery({ status: TAB_STATUS[tab], limit: 50 })
  const checkIn = useCheckInVisitMutation()
  const checkOut = useCheckOutVisitMutation()

  const visits = useMemo(() => visitsQuery.data?.items ?? [], [visitsQuery.data])

  /**
 * Hasil pemindaian memuat kode QR mentah. Payload QR dari backend bersifat
 * opaque (bukan visit_id polos), jadi kita coba dulu dengan kode tersebut,
 * lalu fallback dengan visit_id.
   */
  async function handleScan(raw: string) {
    const code = raw.trim()
    if (code === '') return
    setPhase({ phase: 'processing' })

    try {
      const target = await resolveVisit(code)
      if (target === null) {
        setPhase({
          phase: 'feedback',
          tone: 'error',
          title: 'Tiket tidak ditemukan',
          message: `Kode "${code}" tidak terdaftar. Periksa kembali kode pada QR Code tamu.`,
        })
        return
      }
      if (target.status === 'approved') {
        await checkIn.mutateAsync({ visitId: target.id })
        toast.success(`${target.visit_id} berhasil Check-in MASUK.`)
      } else if (target.status === 'visiting') {
        await checkOut.mutateAsync({ visitId: target.id })
        toast.success(`${target.visit_id} berhasil Check-out KELUAR.`)
      } else {
        setPhase({
          phase: 'feedback',
          tone: 'error',
          title: 'Status tidak dapat diproses',
          message: `Status kunjungan ${target.visit_id} saat ini tidak dapat di-check-in/out.`,
        })
        return
      }
      setPhase({ phase: 'idle' })
    } catch (error) {
      setPhase({
        phase: 'feedback',
        tone: 'error',
        title: 'Gagal memproses tiket',
        message: error instanceof Error ? error.message : 'Terjadi kesalahan di pos jaga.',
      })
    }
  }

  async function handleCheckIn(visit: VisitDetail) {
    setPendingVisitId(visit.id)
    try {
      await checkIn.mutateAsync({ visitId: visit.id })
      toast.success(`${visit.visit_id} berhasil Check-in MASUK.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Check-in gagal.')
    } finally {
      setPendingVisitId(null)
    }
  }

  async function handleCheckOut(visit: VisitDetail) {
    setPendingVisitId(visit.id)
    try {
      await checkOut.mutateAsync({ visitId: visit.id })
      toast.success(`${visit.visit_id} berhasil Check-out KELUAR.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Check-out gagal.')
    } finally {
      setPendingVisitId(null)
    }
  }

  return (
    <SecurityKioskShell
      activeTab={tab}
      onTabChange={(id) => setTab(id as KioskTabId)}
      onSiteCount={tab === 'on-site' ? visits.length : undefined}
    >
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 lg:w-[42%]">
          <ScannerPanel phase={phase} onScan={handleScan} onReset={() => setPhase({ phase: 'idle' })} />
        </div>
        <div className="min-w-0 lg:w-[58%]">
          <GateQueue
            tab={tab}
            visits={visits}
            isLoading={visitsQuery.isPending}
            isError={visitsQuery.isError}
            onRetry={() => void visitsQuery.refetch()}
            pendingVisitId={pendingVisitId}
            onCheckIn={(visit) => void handleCheckIn(visit)}
            onCheckOut={(visit) => void handleCheckOut(visit)}
          />
        </div>
      </div>
    </SecurityKioskShell>
  )
}

/**
 * Terjemahkan kode hasil pindai menjadi satu kunjungan.
 *
 * `getVisit` menerima UUID maupun kode `VST-...`, dan backend menolak
 * apa pun di luar cakupan cabang petugas dengan 404 - jadi tidak ada
 * kebocoran data antar cabang lewat scanner ini.
 */
async function resolveVisit(code: string): Promise<VisitDetail | null> {
  try {
    const { getVisit } = await import('@/lib/api/client')
    return await getVisit(code)
  } catch {
    return null
  }
}
