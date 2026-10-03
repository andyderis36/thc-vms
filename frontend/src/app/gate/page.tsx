'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { SecurityKioskShell, type KioskTabId } from '@/components/layouts/SecurityKioskShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { RequireRole } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import { useCheckInVisitMutation, useCheckOutVisitMutation, useVisitsQuery } from '@/lib/api/hooks'
import type { Role, VisitDetail, VisitStatus } from '@/lib/api/types'
import { ScannerPanel, type ScanPhase } from '@/features/gate/ScannerPanel'
import { GateQueue } from '@/features/gate/GateQueue'
import { ScanResultModal } from '@/features/gate/ScanResultModal'

/** Peta tab gerbang -> status kunjungan yang queried dari API. */
const TAB_STATUS: Record<KioskTabId, VisitStatus> = {
  upcoming: 'approved',
  'on-site': 'visiting',
  completed: 'completed',
}

/**
 * SCR-05 - Security Gate / Site Check-in.
 *
 * PRD §4 + BE `GateOnly`: check-in/out boleh dieksekusi `security`, `admin`
 * (dual-role), DAN `super_admin` (bypass lintas cabang). `RequireRole` yang
 * menahan Vendor/Mitra, dan `security` tidak pernah melihat kontrol persetujuan.
 *
 * Shell mengikuti peran agar transisi dari dashboard tidak janggal: satpam
 * tetap kios zero-sidebar (SHELL-03); admin/superadmin memakai shell
 * masing-masing dengan menu `Pos Check-in` aktif.
 */
export default function GatePage() {
  return (
    <RequireRole allow={['security', 'admin', 'super_admin']}>
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
  const [scanVisit, setScanVisit] = useState<VisitDetail | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanPending, setScanPending] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  // Dinaikkan tiap siklus pindai selesai (tutup modal / konfirmasi sukses)
  // untuk membuka kunci kamera ScannerPanel — lihat props `resetKey`.
  const [scanResetKey, setScanResetKey] = useState(0)
  const { user } = useSession()
  const role: Role | null = user !== null ? user.role : null

  const visitsQuery = useVisitsQuery({ status: TAB_STATUS[tab], limit: 50 })
  const checkIn = useCheckInVisitMutation()
  const checkOut = useCheckOutVisitMutation()
  // Badge antrean shell admin/superadmin (limit 1 — hanya total yang dipakai).
  const pendingQuery = useVisitsQuery({ status: 'requested', limit: 1 })
  const pendingCount = pendingQuery.data?.total ?? 0

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
      if (target.status === 'approved' || target.status === 'visiting') {
        setScanVisit(target)
        setScanError(null)
        setScanOpen(true)
        setPhase({ phase: 'idle' })
        return
      }
      setPhase({
        phase: 'feedback',
        tone: 'error',
        title: 'Status tidak dapat diproses',
        message: `Status kunjungan ${target.visit_id} saat ini tidak dapat di-check-in/out.`,
      })
      return
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

  /**
   * Konfirmasi check-in/out dari modal hasil pindai. Modal HANYA ditutup
   * setelah mutasi selesai sukses; kegagalan mempertahankan modal terbuka
   * dan menampilkan galat di dalamnya (`scanError`) agar petugas bisa
   * membaca penyebab tanpa kehilangan konteks hasil pindaian.
   */
  async function handleScanConfirm() {
    if (scanVisit === null || scanPending) return
    setScanPending(true)
    setScanError(null)
    try {
      if (scanVisit.status === 'approved') {
        await checkIn.mutateAsync({ visitId: scanVisit.id })
        toast.success(`${scanVisit.visit_id} berhasil Check-in MASUK.`)
      } else if (scanVisit.status === 'visiting') {
        await checkOut.mutateAsync({ visitId: scanVisit.id })
        toast.success(`${scanVisit.visit_id} berhasil Check-out KELUAR.`)
      }
      setScanOpen(false)
      setScanVisit(null)
      setScanError(null)
      // Siklus sukses: buka kunci panel pemindai agar QR yang sama bisa
      // langsung dipakai check-out (atau QR berikutnya) tanpa refresh.
      setScanResetKey((key) => key + 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Proses gerbang gagal.'
      setScanError(message)
      toast.error(message)
    } finally {
      setScanPending(false)
    }
  }

  function handleScanClose() {
    if (scanPending) return
    setScanOpen(false)
    setScanVisit(null)
    setScanError(null)
    // Menutup modal juga mengakhiri siklus — lepas kunci kamera agar
    // pemindaian berikutnya tidak tertelan sampai halaman di-refresh.
    setScanResetKey((key) => key + 1)
  }

  const gateContent = (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 lg:w-[42%]">
        <ScannerPanel
          phase={phase}
          onScan={handleScan}
          onReset={() => setPhase({ phase: 'idle' })}
          resetKey={scanResetKey}
        />
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
      <ScanResultModal
        visit={scanVisit}
        open={scanOpen}
        pending={scanPending}
        error={scanError}
        onClose={handleScanClose}
        onConfirm={() => void handleScanConfirm()}
      />
    </div>
  )

  // Shell mengikuti peran: satpam tetap kios zero-sidebar; admin/superadmin
  // memakai shell masing-masing agar transisi dari dashboard tidak janggal.
  if (role === 'admin') {
    return (
      <AdminBranchShell activeHref="/gate" pendingCount={pendingCount}>
        {gateContent}
      </AdminBranchShell>
    )
  }
  if (role === 'super_admin') {
    return (
      <SuperadminShell activeHref="/gate" pendingCount={pendingCount}>
        {gateContent}
      </SuperadminShell>
    )
  }
  return (
    <SecurityKioskShell
      activeTab={tab}
      onTabChange={(id) => setTab(id as KioskTabId)}
      onSiteCount={tab === 'on-site' ? visits.length : undefined}
    >
      {gateContent}
    </SecurityKioskShell>
  )
}

/**
 * Terjemahkan kode hasil pindai menjadi satu kunjungan.
 *
 * `getVisit` menerima UUID maupun kode `VST-...`, dan backend menolak
 * apa pun di luar cakupan cabang petugas (403) - jadi tidak ada
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
