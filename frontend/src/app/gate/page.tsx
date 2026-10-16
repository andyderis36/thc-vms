'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { SecurityKioskShell, type KioskTabId } from '@/components/layouts/SecurityKioskShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { RequireRole } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import {
  useCheckInVisitMutation,
  useCheckOutVisitMutation,
  usePendingApprovalCount,
  useVisitsQuery,
} from '@/lib/api/hooks'
import type { Role, VisitDetail, VisitStatus } from '@/lib/api/types'
import { mergeUpcomingQueue } from '@/lib/visits/upcoming-queue'
import { ScannerPanel, type ScanPhase } from '@/features/gate/ScannerPanel'
import { GateQueue } from '@/features/gate/GateQueue'
import { GuestSelectContext } from '@/features/gate/GuestCard'
import { ScanResultModal } from '@/features/gate/ScanResultModal'

/**
 * Peta tab gerbang -> status utama yang queried dari API.
 * Tab `upcoming` HANYA menyetor `approved` di sini; kunjungan `rescheduled`
 * (juga check-in-able) di-query terpisah lalu digabungkan client-side oleh
 * `mergeUpcomingQueue` — lihat `GateContent`.
 */
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

  const isUpcoming = tab === 'upcoming'
  const visitsQuery = useVisitsQuery({ status: TAB_STATUS[tab], limit: 50 })
  // Tab "Akan Hadir" juga menampilkan kunjungan `rescheduled` (keduanya
  // check-in-able). Query kedua HANYA aktif di tab upcoming agar tab lain
  // tetap single-query; hasilnya digabung client-side oleh mergeUpcomingQueue.
  const rescheduledQuery = useVisitsQuery({ status: 'rescheduled', limit: 50 }, isUpcoming)
  const checkIn = useCheckInVisitMutation()
  const checkOut = useCheckOutVisitMutation()
  // Badge antrean shell admin/superadmin (server-total, limit 1 — hanya total
  // yang dipakai): requested + rescheduled, keduanya menunggu keputusan.
  const { pendingCount } = usePendingApprovalCount()

  /**
   * Semantik gabungan (keputusan, terdokumentasi):
   * - `visits`: gabungan `approved` + `rescheduled` hanya di tab upcoming
   *   (dedupe by id, urut `start_date` ASC); tab lain tetap daftar utama
   *   apa adanya.
   * - Loading: menunggu query UTAMA ATAU query rescheduled (saat tab
   *   upcoming) — antrean baru dirender saat kedua daftar sudah settle.
   * - Error: HANYA dari query utama. Kegagalan query rescheduled tidak
   *   boleh mengosongkan daftar approved (items-nya jatuh ke `[]`, daftar
   *   tetap tampil) — jadi tidak pernah mem-blank antrean yang valid.
   * - Retry: refetch query utama, dan juga query rescheduled saat upcoming.
   */
  const visits = useMemo(() => {
    const primary = visitsQuery.data?.items ?? []
    if (!isUpcoming) return primary
    return mergeUpcomingQueue(primary, rescheduledQuery.data?.items ?? [])
  }, [isUpcoming, visitsQuery.data, rescheduledQuery.data])
  const queueLoading = visitsQuery.isPending || (isUpcoming && rescheduledQuery.isPending)

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

  /**
   * Klik Visit ID pada kartu antrean: muat ULANG data lewat `resolveVisit`
   * (helper yang sama dengan alur pindai) lalu buka `ScanResultModal`.
   * Baris daftar bisa basi (polling tertunda / status berubah), jadi konfirmasi
   * tidak pernah bertumpu pada data cache antrean — identik dengan hasil scan.
   */
  async function handleSelectVisit(visit: VisitDetail) {
    // Naikkan resetKey seperti siklus pindai agar kunci kamera ScannerPanel
    // terlepas; siklus ditutup oleh handleScanClose/handleScanConfirm yang
    // sudah ada (tanpa perubahan perilaku scanner).
    setScanResetKey((key) => key + 1)
    const fresh = await resolveVisit(visit.visit_id)
    if (fresh === null) {
      toast.error(`Detail ${visit.visit_id} gagal dimuat. Coba lagi.`)
      return
    }
    setScanVisit(fresh)
    setScanError(null)
    setScanOpen(true)
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
        {/* Konteks pengganti prop-drilling: GateQueue tidak diubah, tetapi
            GuestCard tetap menerima handler klik kartu untuk popup detail. */}
        <GuestSelectContext.Provider value={handleSelectVisit}>
          <GateQueue
            tab={tab}
            visits={visits}
            isLoading={queueLoading}
            isError={visitsQuery.isError}
            onRetry={() => {
              void visitsQuery.refetch()
              if (isUpcoming) void rescheduledQuery.refetch()
            }}
            pendingVisitId={pendingVisitId}
            onCheckIn={(visit) => void handleCheckIn(visit)}
            onCheckOut={(visit) => void handleCheckOut(visit)}
          />
        </GuestSelectContext.Provider>
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
