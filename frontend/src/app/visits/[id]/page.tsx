'use client'

import { use, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  FileText,
  History,
  MapPin,
  SearchX,
  ShieldAlert,
  Trash2,
  Users,
  XCircle,
} from 'lucide-react'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { EmptyState } from '@/components/ui/EmptyState'
import { Spinner } from '@/components/ui/Spinner'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { PicMobileShell } from '@/components/layouts/PicMobileShell'
import { SecurityKioskShell } from '@/components/layouts/SecurityKioskShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { ApproveModal } from '@/features/visits/components/ApproveModal'
import { RejectModal } from '@/features/visits/components/RejectModal'
import { CancelModal } from '@/features/visits/detail/CancelModal'
import { QrCard } from '@/features/visits/detail/QrCard'
import { RescheduleModal } from '@/features/visits/detail/RescheduleModal'
import { Timeline, formatTanggalWaktu } from '@/features/visits/detail/Timeline'
import { VisitorPhoto } from '@/features/visits/detail/VisitorPhoto'
import { ApiError } from '@/lib/api/fetcher'
import { useDeleteVisitMutation, useVisitQuery } from '@/lib/api/hooks'
import type { Role, VisitDetail, VisitStatus } from '@/lib/api/types'
import { can } from '@/lib/auth/capabilities'
import { RequireAuth } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'

/** Pesan konfirmasi hapus kunjungan — menyebut visit_id agar tidak salah sasaran. */
export function deleteVisitConfirmMessage(visitId: string): string {
  return `Hapus permanen kunjungan "${visitId}"? Tindakan ini tidak dapat dibatalkan.`
}

interface VisitDetailPageProps {
  /**
   * Next.js 16: `params` adalah Promise — di-await (atau dibuka dengan
   * `use()`) di dalam komponen client. Akses sinkron (`params.id`)
   * sudah dihapus dan akan membuat build gagal.
   */
  params: Promise<{ id: string }>
}

/** Kunjungan yang statusnya sudah berakhir tidak lagi bisa diubah/dibatalkan. */
const TERMINAL_STATUSES: ReadonlySet<VisitStatus> = new Set<VisitStatus>([
  'completed',
  'rejected',
  'cancelled',
  'not_visit',
])

/**
 * SCR-04 — Detail Kunjungan & Pas Masuk QR.
 * Dilindungi `RequireAuth` lalu dibungkus shell sesuai peran pengguna.
 */
export default function VisitDetailPage({ params }: VisitDetailPageProps) {
  const { id } = use(params)

  return (
    <RequireAuth>
      <VisitDetailScreen visitId={id} />
    </RequireAuth>
  )
}

function LoadingBlock() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner size="lg" label="Memuat detail kunjungan…" />
    </div>
  )
}

interface ErrorBlockProps {
  error: unknown
  onRetry: () => void
}

/** Layar galat per status HTTP: 404 -> "Kunjungan tidak ditemukan", 403 -> akses ditolak. */
function ErrorBlock({ error, onRetry }: ErrorBlockProps) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Card>
        <EmptyState
          icon={<SearchX aria-hidden="true" className="size-10" />}
          title="Kunjungan tidak ditemukan"
          description="Kunjungan yang Anda cari tidak ada atau tidak berada dalam lingkup akses Anda."
        />
      </Card>
    )
  }

  if (error instanceof ApiError && error.status === 403) {
    return (
      <Card>
        <EmptyState
          icon={<ShieldAlert aria-hidden="true" className="size-10" />}
          title="Akses ditolak"
          description="Anda tidak memiliki akses untuk melihat detail kunjungan ini. Hubungi admin cabang terkait."
        />
      </Card>
    )
  }

  const message =
    error instanceof ApiError ? error.message : 'Terjadi kesalahan. Silakan coba lagi.'

  return (
    <Card>
      <EmptyState
        title="Gagal memuat kunjungan"
        description={message}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Coba Lagi
          </Button>
        }
      />
    </Card>
  )
}

interface RoleShellProps {
  role: Role
  visitId: string
  /**
   * Status kunjungan bila sudah termuat. SHELL-04 (Vendor/Mitra) memakainya untuk
   * memetakan rute detail ini ke tab Vendor/Mitra yang benar (approved/visiting ->
   * `/qr`, selainnya -> `/dashboard`) sehingga SCR-04 selalu punya
   * `aria-current`. Shell lain mengabaikannya.
   */
  visitStatus?: VisitStatus
  children: ReactNode
}

/** Pilih base layout (SHELL-01..04) sesuai peran — tanpa memihak peran tertentu. */
function RoleShell({ role, visitId, visitStatus, children }: RoleShellProps) {
  const activeHref = `/visits/${visitId}`

  switch (role) {
    case 'vendor':
      return (
        <PicMobileShell activeHref={activeHref} visitStatus={visitStatus}>
          {children}
        </PicMobileShell>
      )
    case 'admin':
      return <AdminBranchShell activeHref={activeHref}>{children}</AdminBranchShell>
    case 'security':
      return <SecurityKioskShell>{children}</SecurityKioskShell>
    case 'super_admin':
      return <SuperadminShell activeHref={activeHref}>{children}</SuperadminShell>
  }
}

interface VisitDetailScreenProps {
  visitId: string
}

function VisitDetailScreen({ visitId }: VisitDetailScreenProps) {
  const { user } = useSession()
  const visitQuery = useVisitQuery(visitId)
  const role = user !== null ? user.role : null

  if (role === null) {
    return <LoadingBlock />
  }

  const visit = visitQuery.data

  return (
    <RoleShell role={role} visitId={visitId} visitStatus={visit?.status}>
      {visitQuery.isPending ? (
        <LoadingBlock />
      ) : visitQuery.isError ? (
        <ErrorBlock error={visitQuery.error} onRetry={() => void visitQuery.refetch()} />
      ) : visit !== undefined ? (
        <VisitDetailView visit={visit} visitId={visitId} role={role} />
      ) : (
        <LoadingBlock />
      )}
    </RoleShell>
  )
}

interface InfoRowProps {
  label: string
  value: ReactNode
}

function InfoRow({ label, value }: InfoRowProps) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-label font-semibold text-ink-secondary sm:w-44">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-sm text-ink">{value}</dd>
    </div>
  )
}

interface VisitDetailViewProps {
  visit: VisitDetail
  visitId: string
  role: Role
}

function VisitDetailView({ visit, visitId, role }: VisitDetailViewProps) {
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [approveOpen, setApproveOpen] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const router = useRouter()
  const deleteMutation = useDeleteVisitMutation()
  const showDelete = can(role, 'deleteRecords')

  const isTerminal = TERMINAL_STATUSES.has(visit.status)
  // Kontrol aksi mengikuti matriks kapabilitas — Vendor/Mitra tidak pernah melihat
  // kontrol approval, dan satpam tidak bisa mengubah jadwal/membatalkan.
  const canReschedule = !isTerminal && can(role, 'rescheduleVisit')
  const canCancel = !isTerminal && can(role, 'cancelVisit')
  // Persetujuan di SCR-04 (inventaris §3: modal approve/reject ada di SCR-02
  // & SCR-04): hanya status requested + peran berhak. Gaya tombol disamakan
  // dengan VisitTable (success/danger, min-h-touch, aria-label).
  // Vendor/Mitra & security tidak memiliki `approveVisit`/`rejectVisit` sehingga kedua
  // tombol itu tidak pernah dirender untuk mereka (PRD §4 — RBAC murni).
  const canApprove = visit.status === 'requested' && can(role, 'approveVisit')
  const canReject = visit.status === 'requested' && can(role, 'rejectVisit')
  const showActions = canReschedule || canCancel || canApprove || canReject
  // QR tampil selama `approved` (untuk check-in) DAN `visiting` (untuk
  // check-out): payload QR == visit_id stabil per kunjungan, dan scanner
  // gerbang mengarahkan otomatis approved->check-in, visiting->check-out.
  // Status lain (requested/cancelled/completed/...) menyembunyikan QR.
  const showQr = visit.status === 'approved' || visit.status === 'visiting'

  const purposeChips =
    visit.purposes.length > 0 ? (
      <div className="flex flex-wrap gap-2">
        {visit.purposes.map((purpose) => (
          <Badge key={purpose.id} tone="info">
            {purpose.name}
          </Badge>
        ))}
      </div>
    ) : (
      '—'
    )

  return (
    <>
      {/*
        GRID DUA KOLOM DESKTOP (>= 1024px): detail kiri ~65% (8/12),
        QR kanan ~35% (4/12) dan sticky. Kartu QR sengaja PALING AWAL pada
        urutan sumber — di ponsel ia menjadi elemen pertama di alur dokumen
        (above-the-fold) tanpa pengurutan CSS.
      */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-4 lg:col-start-9 lg:row-span-2 lg:row-start-1">
          <div className="lg:sticky lg:top-24">
            <QrCard
              visitId={visitId}
              visitCode={visit.visit_id}
              qrVisible={showQr}
            />
          </div>
        </div>

        <div className="min-w-0 lg:col-span-8 lg:col-start-1 lg:row-start-1">
          <Card>
            <CardBody>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <h1 className="text-2xl font-bold text-ink">{visit.visit_id}</h1>
                  <StatusBadge status={visit.status} />
                </div>
                {showActions && (
                  <div className="flex flex-wrap items-center gap-2">
                    {canApprove && (
                      <Button
                        size="sm"
                        variant="success"
                        className="min-h-touch px-3"
                        aria-label={`Setujui kunjungan ${visit.visit_id}`}
                        onClick={() => setApproveOpen(true)}
                      >
                        <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
                        Setujui
                      </Button>
                    )}
                    {canReject && (
                      <Button
                        size="sm"
                        variant="danger"
                        className="min-h-touch px-3"
                        aria-label={`Tolak kunjungan ${visit.visit_id}`}
                        onClick={() => setRejectOpen(true)}
                      >
                        <XCircle aria-hidden="true" className="size-4 shrink-0" />
                        Tolak
                      </Button>
                    )}
                    {canReschedule && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="min-h-touch"
                        onClick={() => setRescheduleOpen(true)}
                      >
                        <CalendarClock aria-hidden="true" className="size-4 shrink-0" />
                        Ubah Jadwal
                      </Button>
                    )}
                    {canCancel && (
                      <Button
                        variant="danger"
                        size="sm"
                        className="min-h-touch"
                        onClick={() => setCancelOpen(true)}
                      >
                        <XCircle aria-hidden="true" className="size-4 shrink-0" />
                        Batalkan Kunjungan
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </CardBody>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:col-span-8 lg:col-start-1 lg:row-start-2">
          {/* Panel Informasi Lengkap */}
          <Card>
            <CardBody>
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <MapPin aria-hidden="true" className="size-4 shrink-0 text-ink-secondary" />
                Informasi Kunjungan
              </h2>
              <dl className="mt-3 divide-y divide-border-light">
                <InfoRow
                  label="Vendor/Mitra"
                  value={
                    <>
                      {visit.pic_user.name}
                      <span className="block text-label text-ink-muted">
                        {visit.pic_user.email}
                      </span>
                    </>
                  }
                />
                <InfoRow label="Lokasi" value={visit.location.name} />
                <InfoRow label="Keperluan" value={purposeChips} />
                {/* "Tujuan lain" (purpose_note) hanya bila terisi. */}
                {visit.purpose_note != null &&
                visit.purpose_note.trim() !== '' ? (
                  <InfoRow label="Tujuan lain" value={visit.purpose_note} />
                ) : null}
                <InfoRow
                  label="Rentang Waktu"
                  value={`${formatTanggalWaktu(visit.start_date)} – ${formatTanggalWaktu(visit.end_date)}`}
                />
                <InfoRow
                  label="Catatan"
                  value={
                    visit.notes !== null && visit.notes.trim() !== ''
                      ? visit.notes
                      : 'Tidak ada catatan.'
                  }
                />
              </dl>
            </CardBody>
          </Card>

          {/* Panel Dokumen Surat Tugas */}
          <Card>
            <CardBody>
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-secondary" />
                Dokumen Surat Tugas
              </h2>
              {/*
                Cek truthy (bukan `!== null`): string kosong sama saja tidak
                ada dokumen — jika tetap dirender, href="" membuka tab kosong.
              */}
              {visit.assignment_letter_url ? (
                <div className="mt-4 flex flex-col items-start gap-2">
                  <a
                    href={visit.assignment_letter_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Lihat dokumen surat tugas ${visit.visit_id}`}
                    className="inline-flex min-h-touch items-center justify-center gap-2 rounded-control border border-brand px-4 text-label font-semibold uppercase tracking-wide text-brand transition duration-150 hover:bg-brand-soft"
                  >
                    <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
                    Lihat Dokumen
                  </a>
                  <p className="text-label text-ink-muted">
                    Berkas dibuka di tab baru langsung dari penyimpanan MinIO / S3.
                  </p>
                </div>
              ) : (
                <p className="mt-4 rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
                  Belum ada dokumen surat tugas yang dilampirkan.
                </p>
              )}
            </CardBody>
          </Card>

          {/* Daftar Tim Teknisi */}
          <Card>
            <CardBody>
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <Users aria-hidden="true" className="size-4 shrink-0 text-ink-secondary" />
                {`Tim Teknisi (${visit.visitors.length} orang)`}
              </h2>
              {visit.visitors.length > 0 ? (
                <ul className="mt-3 divide-y divide-border-light">
                  {visit.visitors.map((visitor, index) => {
                    const selfieUrl = visitor.photo_url ?? null
                    const ktpUrl = visitor.id_card_photo_url ?? null
                    return (
                      <li
                        key={`${index}-${visitor.id_number}`}
                        className="flex items-start gap-3 py-3"
                      >
                        <VisitorPhoto
                          src={selfieUrl}
                          visitorName={visitor.name}
                          variant="selfie"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-ink">
                            {visitor.name}
                          </p>
                          <p className="text-label text-ink-secondary">
                            {`No. Identitas: ${visitor.id_number}`}
                          </p>
                          <p className="text-label text-ink-secondary">
                            {visitor.phone !== '' ? visitor.phone : '—'}
                          </p>
                          <p className="text-label text-ink-secondary">
                            {`Perusahaan: ${(visitor.vendor_name ?? '').trim() !== '' ? visitor.vendor_name : '—'}`}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            {ktpUrl !== null && ktpUrl !== '' ? (
                              <a
                                href={ktpUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Lihat Foto KTP ${visitor.name}`}
                                className="inline-flex min-h-touch items-center rounded-badge border border-border-mid px-2.5 text-badge font-semibold text-brand"
                              >
                                Lihat Foto KTP
                              </a>
                            ) : (
                              <span className="text-badge text-ink-muted">
                                Foto KTP tidak tersedia
                              </span>
                            )}
                            {selfieUrl === null || selfieUrl === '' ? (
                              <span className="text-badge text-ink-muted">
                                Selfie tidak tersedia
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="mt-3 rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
                  Belum ada data teknisi pada kunjungan ini.
                </p>
              )}
            </CardBody>
          </Card>

          {/* Panel Riwayat Status */}
          <Card>
            <CardBody>
              <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                <History aria-hidden="true" className="size-4 shrink-0 text-ink-secondary" />
                Riwayat Status
              </h2>
              <div className="mt-4">
                <Timeline
                  status={visit.status}
                  createdAt={visit.created_at}
                  startDate={visit.start_date}
                  endDate={visit.end_date}
                  checkInAt={visit.check_in_at ?? null}
                  checkOutAt={visit.check_out_at ?? null}
                />
              </div>
            </CardBody>
          </Card>

          {showDelete ? (
            <Card>
              <CardBody>
                <h2 className="flex items-center gap-2 text-base font-semibold text-danger-text">
                  <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                  Zona Berbahaya
                </h2>
                <p className="mt-2 text-sm text-ink-secondary">
                  Hapus permanen kunjungan ini beserta seluruh datanya. Berlaku untuk status apa pun dan tidak dapat dibatalkan.
                </p>
                <Button
                  variant="danger"
                  className="mt-4 min-h-touch"
                  aria-label={`Hapus permanen kunjungan ${visit.visit_id}`}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                  Hapus Permanen
                </Button>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      {rescheduleOpen && (
        <RescheduleModal
          visitId={visitId}
          open
          onClose={() => setRescheduleOpen(false)}
          initialStartDate={visit.start_date}
          initialEndDate={visit.end_date}
        />
      )}
      {cancelOpen && <CancelModal visitId={visitId} open onClose={() => setCancelOpen(false)} />}
      {approveOpen && (
        <ApproveModal visit={visit} open onClose={() => setApproveOpen(false)} />
      )}
      {rejectOpen && (
        <RejectModal visit={visit} open onClose={() => setRejectOpen(false)} />
      )}
      {deleteOpen && (
        <ConfirmModal
          open
          title={`Hapus ${visit.visit_id}`}
          message={deleteVisitConfirmMessage(visit.visit_id)}
          loading={deleteMutation.isPending}
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => {
            deleteMutation.mutate(
              { visitId },
              {
                onSuccess: () => {
                  toast.success(`Kunjungan ${visit.visit_id} dihapus permanen`)
                  setDeleteOpen(false)
                  router.replace('/dashboard')
                },
                onError: (error) => {
                  toast.error(apiErrorMessage(error))
                },
              },
            )
          }}
        />
      )}
    </>
  )
}
