import { CalendarClock, Inbox, UserCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import type { KioskTabId } from '@/components/layouts/SecurityKioskShell'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import type { VisitDetail } from '@/lib/api/types'
import { GuestCard } from './GuestCard'

export interface GateQueueProps {
  /** Tab gerbang aktif — menentukan kosong/tampil dan aksi yang tersedia. */
  tab: KioskTabId
  visits: VisitDetail[]
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  /** Visit ID yang sedang diproses check-in/out agar hanya kartu itu yang sibuk. */
  pendingVisitId: string | null
  onCheckIn: (visit: VisitDetail) => void
  onCheckOut: (visit: VisitDetail) => void
}

interface EmptyContent {
  icon: ReactNode
  title: string
  description: string
}

/** Pesan kosong per tab (Bahasa Indonesia) — pasangan label tab di shell kiosk. */
function emptyContentFor(tab: KioskTabId): EmptyContent {
  switch (tab) {
    case 'upcoming':
      return {
        icon: <CalendarClock className="size-10" />,
        title: 'Belum ada kunjungan yang akan hadir',
        description: 'Kunjungan terjadwal yang sudah disetujui hari ini akan muncul di sini.',
      }
    case 'on-site':
      return {
        icon: <UserCheck className="size-10" />,
        title: 'Belum ada teknisi di lokasi',
        description: 'Teknisi yang sudah check-in dan berada di area pos akan tampil di sini.',
      }
    case 'completed':
      return {
        icon: <Inbox className="size-10" />,
        title: 'Belum ada kunjungan selesai',
        description: 'Kunjungan yang sudah check-out hari ini akan muncul di daftar ini.',
      }
  }
}

/**
 * Antrean gerbang SCR-05 — daftar vertikal kartu tamu untuk tab aktif.
 *
 * Muat = `Spinner`, galat = `EmptyState` + tombol coba lagi, kosong = `EmptyState`
 * sesuai tab. Tidak ada tabel dan tidak ada scroll horizontal (AGENTS.md §6.5):
 * seluruh antrean adalah tumpukan kartu yang tumbuh ke bawah.
 */
export function GateQueue({
  tab,
  visits,
  isLoading,
  isError,
  onRetry,
  pendingVisitId,
  onCheckIn,
  onCheckOut,
}: GateQueueProps) {
  if (isLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Spinner size="lg" label="Memuat antrean gerbang…" />
      </div>
    )
  }

  if (isError) {
    return (
      <Card>
        <EmptyState
          title="Antrean gerbang gagal dimuat"
          description="Data kunjungan tidak dapat diambil. Periksa koneksi jaringan lalu coba lagi."
          action={
            <Button variant="secondary" onClick={onRetry}>
              Coba Lagi
            </Button>
          }
        />
      </Card>
    )
  }

  if (visits.length === 0) {
    const empty = emptyContentFor(tab)
    return (
      <Card>
        <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
      </Card>
    )
  }

  return (
    <section aria-label="Daftar kunjungan gerbang" className="flex min-w-0 flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {visits.map((visit) => (
          <GuestCard
            key={visit.id}
            visit={visit}
            pending={pendingVisitId === visit.id}
            onCheckIn={onCheckIn}
            onCheckOut={onCheckOut}
          />
        ))}
      </ul>
    </section>
  )
}
