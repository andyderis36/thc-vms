'use client'

import { use, useState, type FormEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  FileText,
  History,
  MapPin,
  SearchX,
  ShieldAlert,
  Trash2,
  Users,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { Badge, StatusBadge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { AdminBranchShell } from '@/components/layouts/AdminBranchShell'
import { VendorMobileShell, isQrVisible } from '@/components/layouts/VendorMobileShell'
import { SecurityKioskShell } from '@/components/layouts/SecurityKioskShell'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { ApproveModal } from '@/features/visits/components/ApproveModal'
import { RejectModal } from '@/features/visits/components/RejectModal'
import { SpkFileLink } from '@/features/visits/components/SpkFileLink'
import { CancelModal } from '@/features/visits/detail/CancelModal'
import { QrCard } from '@/features/visits/detail/QrCard'
import { RescheduleModal } from '@/features/visits/detail/RescheduleModal'
import { Timeline, formatTanggalWaktu } from '@/features/visits/detail/Timeline'
import { VisitorPhoto } from '@/features/visits/detail/VisitorPhoto'
import { VisitFilePhoto } from '@/features/visits/detail/VisitFilePhoto'
import { WorkPhotoCard } from '@/features/visits/detail/WorkPhotoCard'
import { ApiError } from '@/lib/api/fetcher'
import {
  useCompleteVisitMutation,
  useDeleteVisitMutation,
  useUpdateVisitorContactMutation,
  useVisitLogsQuery,
  useVisitQuery,
} from '@/lib/api/hooks'
import type { Role, VisitDetail, VisitorItem, VisitStatus } from '@/lib/api/types'
import {
  canCompleteVisit,
} from '@/lib/visits/gate-status'
import { can, getLoginRedirect } from '@/lib/auth/capabilities'
import { RequireAuth } from '@/lib/auth/guards'
import { useSession } from '@/lib/auth/session'
import {
  PHONE_MAX_LENGTH,
  isValidPhone,
  sanitizePhoneInput,
} from '@/lib/limits'
import {
  isApprovableStatus,
  isCancelableStatus,
  isRejectableStatus,
  isReschedulableStatus,
  isVisitorContactEditableStatus,
} from '@/lib/visits/visit-status'
import { visitVendorUser } from '@/lib/visits/vendor-user'
import { visitVendorCompany } from '@/lib/visits/visit-company'
import { VisitLogsTimeline } from './VisitLogsTimeline'
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

/**
 * Panel "Dokumen Surat Tugas" — berkas diambil lewat komponen bersama
 * `SpkFileLink` (object URL dari endpoint berkas kunjungan, bukan presigned
 * MinIO), sehingga perlakuan memuat/gagal & gaya tautan identik dengan
 * dashboard & approvals. Selama berkas dimuat atau gagal dimuat, komponen
 * tersebut mengembalikan `fallback` netral yang sama persis dengan kondisi
 * tanpa dokumen — sehingga tidak ada kedipan layout di panel ini.
 */
function SuratTugasPanel({ visit }: { visit: VisitDetail }) {
  return (
    <div className="mt-4 flex flex-col items-start gap-2">
      <SpkFileLink
        visitId={visit.id}
        className="inline-flex min-h-touch items-center gap-2 font-medium text-brand underline underline-offset-2 transition-colors hover:text-brand-dark"
        ariaLabel={`Lihat dokumen surat tugas ${visit.visit_id}`}
        fallback={
          <p className="rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
            Surat tugas sedang dimuat. Bila tidak muncul, muat ulang halaman.
          </p>
        }
      >
        Lihat Dokumen
      </SpkFileLink>
      <p className="text-label text-ink-muted">
        Berkas dibuka di tab baru langsung dari penyimpanan MinIO / S3.
      </p>
    </div>
  )
}

interface RoleShellProps {
  role: Role
  visitId: string
  /**
   * Status kunjungan bila sudah termuat. SHELL-04 (Vendor/Mitra) memakainya untuk
   * memetakan rute detail ini ke tab Vendor/Mitra yang benar (approved/visiting
   * -> `/qr`, selainnya -> `/dashboard`) sehingga SCR-04 selalu punya
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
        <VendorMobileShell activeHref={activeHref} visitStatus={visitStatus}>
          {children}
        </VendorMobileShell>
      )
    case 'admin':
      return <AdminBranchShell activeHref={activeHref}>{children}</AdminBranchShell>
    case 'security':
      return <SecurityKioskShell>{children}</SecurityKioskShell>
    case 'super_admin':
    case 'dev-superadmin':
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
        <VisitDetailView
          visit={visit}
          visitId={visitId}
          role={role}
          onRefresh={() => void visitQuery.refetch()}
        />
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
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="shrink-0 text-label font-semibold text-ink-secondary sm:w-44">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-sm text-ink">{value}</dd>
    </div>
  )
}

interface PanelTitleProps {
  icon: LucideIcon
  tone?: 'brand' | 'danger'
  /** Sisipan kanan (badge jumlah, dsb.) — opsional. */
  trailing?: ReactNode
  children: ReactNode
}

/** Judul panel dengan chip ikon tint (token `rounded-control` + warna soft proyek). */
function PanelTitle({ icon: Icon, tone = 'brand', trailing, children }: PanelTitleProps) {
  const chip = tone === 'danger' ? 'bg-danger-bg text-danger-text' : 'bg-brand-soft text-brand'
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex min-w-0 items-center gap-3 text-base font-semibold text-ink">
        <span
          aria-hidden="true"
          className={`flex size-9 shrink-0 items-center justify-center rounded-control ${chip}`}
        >
          <Icon className="size-4 shrink-0" />
        </span>
        <span className={tone === 'danger' ? 'text-danger-text' : undefined}>{children}</span>
      </h2>
      {trailing !== undefined ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  )
}

/** Pesan galat aman tampil dari `ApiError` atau galat tak dikenal. */
function toContactErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message
  }
  return 'Terjadi kesalahan. Silakan coba lagi.'
}

interface VisitorContactRowProps {
  visitId: string
  visitor: VisitorItem
  /** `true` hanya untuk pembuat kunjungan pada status yang masih bisa diubah. */
  canEdit: boolean
}

/**
 * Satu baris anggota + editor kontak inline milik pembuat (No. HP saja).
 * Kirim parsial (hanya bila berubah, pola `ProfileForm`); penanda `(diubah)`
 * dirender dari `phone_edited` server.
 */
function VisitorContactRow({ visitId, visitor, canEdit }: VisitorContactRowProps) {
  const [editing, setEditing] = useState(false)
  const [phone, setPhone] = useState(visitor.phone)
  const [phoneError, setPhoneError] = useState<string | undefined>(undefined)
  const updateContact = useUpdateVisitorContactMutation()

  const visitorId = visitor.id
  const editable = canEdit && visitorId !== undefined

  function openEditor(): void {
    setPhone(visitor.phone)
    setPhoneError(undefined)
    setEditing(true)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (visitorId === undefined) {
      return
    }
    const nextPhone = phone.trim()
    const phoneChanged = nextPhone !== visitor.phone
    let valid = true
    if (phoneChanged) {
      if (nextPhone === '') {
        setPhoneError('Nomor HP anggota wajib diisi.')
        valid = false
      } else if (!isValidPhone(nextPhone)) {
        setPhoneError('Nomor HP anggota tidak valid (10-16 digit angka, diawali 0 atau 62).')
        valid = false
      } else {
        setPhoneError(undefined)
      }
    } else {
      setPhoneError(undefined)
    }
    if (!valid) {
      return
    }
    if (!phoneChanged) {
      setEditing(false)
      return
    }
    try {
      await updateContact.mutateAsync({
        visitId,
        visitorId,
        body: { phone: nextPhone },
      })
      toast.success('Kontak anggota berhasil diperbarui.')
      setEditing(false)
    } catch {
      // Pesan gagal ditampilkan dari `updateContact.error` di bawah.
    }
  }

  return (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-semibold text-ink">
        {visitor.name}
      </p>
      <p className="break-words text-label text-ink-secondary">
        {`No. Identitas: ${visitor.id_number}`}
      </p>
      <p className="break-words text-label text-ink-secondary">
        {`No. HP: ${visitor.phone !== '' ? visitor.phone : '—'}`}
        {visitor.phone_edited === true ? (
          <Badge tone="info" className="ml-2">(diubah)</Badge>
        ) : null}
      </p>
      <p className="text-label text-ink-secondary">
        {`Perusahaan: ${(visitor.vendor_name ?? '').trim() !== '' ? visitor.vendor_name : '—'}`}
      </p>
      <p className="text-label text-ink-secondary">
        {`Jabatan: ${(visitor.jabatan ?? '').trim() !== '' ? visitor.jabatan : '—'}`}
      </p>
      <p className="text-label text-ink-secondary">
        {`Email: ${(visitor.email ?? '').trim() !== '' ? visitor.email : '—'}`}
      </p>
      {editing ? (
        <form onSubmit={handleSubmit} className="mt-2 flex flex-col gap-3">
          {updateContact.isError ? (
            <p role="alert" className="rounded-control bg-danger-bg px-3 py-2 text-sm text-danger-text">
              {toContactErrorMessage(updateContact.error)}
            </p>
          ) : null}
          <Input
            label="Nomor HP"
            value={phone}
            error={phoneError}
            inputMode="tel"
            maxLength={PHONE_MAX_LENGTH}
            onChange={(event) => setPhone(sanitizePhoneInput(event.target.value))}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              loading={updateContact.isPending}
              className="min-h-touch"
            >
              Simpan
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-touch"
              disabled={updateContact.isPending}
              onClick={() => setEditing(false)}
            >
              Batal
            </Button>
          </div>
        </form>
      ) : null}
      <div className="mt-1.5 flex flex-wrap gap-2">
        {editable && !editing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-touch"
            aria-label={`Ubah kontak ${visitor.name}`}
            onClick={openEditor}
          >
            Ubah Kontak
          </Button>
        ) : null}
        {visitor.id_card_photo_url !== null &&
        visitor.id_card_photo_url !== undefined &&
        visitor.id_card_photo_url !== '' ? (
          <VisitFilePhoto
            visitId={visitId}
            visitor={visitor}
            variant="ktp"
            triggerLabel="Lihat Foto KTP"
          />
        ) : (
          <span className="text-badge text-ink-muted">
            Foto KTP tidak tersedia
          </span>
        )}
        {visitor.photo_url === null ||
        visitor.photo_url === undefined ||
        visitor.photo_url === '' ? (
          <span className="text-badge text-ink-muted">
            Selfie tidak tersedia
          </span>
        ) : null}
      </div>
    </div>
  )
}

interface VisitDetailViewProps {
  visit: VisitDetail
  visitId: string
  role: Role
  onRefresh: () => void
}

function VisitDetailView({ visit, visitId, role, onRefresh }: VisitDetailViewProps) {
  const { user: sessionUser } = useSession()
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [approveOpen, setApproveOpen] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [completeOpen, setCompleteOpen] = useState(false)
  const router = useRouter()
  const deleteMutation = useDeleteVisitMutation()
  const completeMutation = useCompleteVisitMutation()
  const logsQuery = useVisitLogsQuery(visitId)
  const showDelete = can(role, 'deleteRecords')
  // Siklus aktif = `in` terakhir yang belum ditutup `out` — dibawa sebagai
  // `visit_log_id` saat mengunggah agar bukti terikat ke siklus ini.
  const visitLogs = logsQuery.data ?? []
  let activeVisitLogId: string | null = null
  for (const log of visitLogs) {
    if (log.direction === 'in') {
      activeVisitLogId = log.id
    } else if (log.direction === 'out') {
      activeVisitLogId = null
    }
  }

  // Pengaju Vendor/Mitra via helper transisi Fase 1 (fallback `pic_user`).
  const vendorUser = visitVendorUser(visit)
  // Editor kontak anggota khusus pembuat: peran vendor + id sesi sama dengan
  // pengaju + status masih sebelum persetujuan (requested/rescheduled —
  // paritas dengan gerbang usecase backend; lihat isVisitorContactEditableStatus).
  const isOwnerVendor =
    role === 'vendor' &&
    sessionUser !== null &&
    vendorUser !== undefined &&
    vendorUser.id === sessionUser.id
  // Pengunggah bukti kerja: vendor pemilik ATAU pembuat kunjungan
  // (`created_by` = id sesi, untuk admin/super_admin pembuatnya) — paritas
  // dengan gerbang usecase backend; security tidak pernah lolos.
  const isCreator =
    sessionUser !== null &&
    visit.created_by != null &&
    visit.created_by !== '' &&
    visit.created_by === sessionUser.id
  const canEditVisitorContact = isOwnerVendor && isVisitorContactEditableStatus(visit.status)
  // Kontrol aksi mengikuti matriks kapabilitas — Vendor/Mitra tidak pernah melihat
  // kontrol approval, dan pengawas tidak bisa mengubah jadwal/membatalkan.
  // Ubah Jadwal & Batal hanya dirender bila status sumbernya legal di backend:
  // `requested`, `approved`, atau `rescheduled`. `visiting` dikecualikan karena
  // backend hanya mengizinkan `visiting→completed` (check-out), sehingga tombol
  // di sana selalu gagal 409 INVALID_TRANSITION.
  const canReschedule = isReschedulableStatus(visit.status) && can(role, 'rescheduleVisit')
  const canCancel = isCancelableStatus(visit.status) && can(role, 'cancelVisit')
  // Persetujuan di SCR-04 (inventaris §3: modal approve/reject ada di SCR-02
  // & SCR-04): status requested ATAU rescheduled + peran berhak — backend
  // mengizinkan `rescheduled→approved` (perlu persetujuan ulang setelah jadwal
  // digeser). Tolak tetap HANYA requested (`rescheduled→rejected` ilegal).
  // Gaya tombol disamakan dengan VisitTable (success/danger, min-h-touch,
  // aria-label). Vendor/Mitra & security tidak memiliki `approveVisit`/
  // `rejectVisit` sehingga kedua tombol itu tidak pernah dirender untuk
  // mereka (PRD §4 — RBAC murni).
  const canApprove = isApprovableStatus(visit.status) && can(role, 'approveVisit')
  const canReject = isRejectableStatus(visit.status) && can(role, 'rejectVisit')
  const canComplete = canCompleteVisit(visit.status, role)
  const showActions = canReschedule || canCancel || canApprove || canReject || canComplete
  // QR tampil selama `approved` (untuk check-in) dan `visiting` (untuk
  // check-out, QR yang SAMA). `rescheduled` WAJIB disetujui ulang sebelum
  // check-in (backend menolak rescheduled->visiting), jadi QR disembunyikan
  // sampai status kembali `approved`. Status lain (requested/cancelled/
  // completed/...) menyembunyikan QR.
  const showQr = isQrVisible(visit.status)

  // Perusahaan pengaju: override manual per kunjungan → perusahaan akun
  // vendor → nama pemegang akun (lihat `visitVendorCompany`).
  const vendorCompany = visitVendorCompany(visit)

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

  // Tombol kembali: peran `security` TIDAK mendapatkannya di sini karena
  // `SecurityKioskShell` sudah merender "Kembali ke Pos Check-in" di topbar
  // (teks di desktop, ikon di ponsel) - tombol kedua berarti aksi ganda.
  // Peran lain tidak punya tautan kembali di shell-nya.
  const backTarget = getLoginRedirect(role)

  return (
    <>
      {role !== 'security' ? (
        <div className="mb-4 flex flex-col gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-touch self-start"
            onClick={() => router.push(backTarget)}
          >
            <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
            Kembali ke Dashboard
          </Button>
        </div>
      ) : null}
      {/*
        GRID DUA KOLOM DESKTOP (>= 1024px): detail kiri ~65% (8/12),
        QR kanan ~35% (4/12) dan sticky. Kartu QR sengaja PALING AWAL pada
        urutan sumber — di ponsel ia menjadi elemen pertama di alur dokumen
        (above-the-fold) tanpa pengurutan CSS. Ikatan `lg:*` hanya berlaku
        >= 1024px, jadi di ponsel urutan sumber = urutan visual dan tidak
        ada header/banner yang bisa mendorong kartu QR ke bawah lipatan.
        Jangan pakai `items-start`: sel grid harus setinggi dua barisnya
        agar `lg:sticky` pada kartu QR punya ruang untuk menempel.
        Tombol kembali berada DI LUAR grid (saudara sebelumnya), jadi kartu QR
        tetap anak PERTAMA grid dan penempatan kolom `lg:*`-nya tidak berubah.
      */}
      <div className="grid gap-4 sm:gap-5 lg:grid-cols-12 lg:gap-6">
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
          <Card className="border-brand/20 bg-brand-soft/40">
            <CardBody className="p-4 sm:p-5">
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="inline-flex min-w-0 items-center rounded-control bg-surface px-3 py-2 font-mono text-lg font-bold tracking-tight text-ink sm:text-xl">
                    <span className="wrap-anywhere">{visit.visit_id}</span>
                  </h1>
                  <StatusBadge status={visit.status} />
                </div>
                {showActions && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-brand/20 pt-4">
                    {canApprove && (
                      <Button
                        size="sm"
                        variant="success"
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
                        aria-label={`Tolak kunjungan ${visit.visit_id}`}
                        onClick={() => setRejectOpen(true)}
                      >
                        <XCircle aria-hidden="true" className="size-4 shrink-0" />
                        Tolak
                      </Button>
                    )}
                    {canReschedule && (
                      <Button variant="secondary" size="sm" onClick={() => setRescheduleOpen(true)}>
                        <CalendarClock aria-hidden="true" className="size-4 shrink-0" />
                        Ubah Jadwal
                      </Button>
                    )}
                    {canCancel && (
                      <Button variant="danger" size="sm" onClick={() => setCancelOpen(true)}>
                        <XCircle aria-hidden="true" className="size-4 shrink-0" />
                        Batalkan Kunjungan
                      </Button>
                    )}
                    {canComplete && (
                      <Button
                        variant="success"
                        size="sm"
                        aria-label={`Selesaikan kunjungan ${visit.visit_id}`}
                        onClick={() => setCompleteOpen(true)}
                      >
                        <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
                        Selesaikan
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </CardBody>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4 sm:gap-5 lg:col-span-8 lg:col-start-1 lg:row-start-2 lg:gap-6">
          {/* Riwayat Status diletakkan kedua (tepat setelah kartu identitas):
              status adalah hal pertama yang dicari teknisi setelah QR, jadi
              timeline vertikal harus terbaca tanpa menggulir melewati panel
              lain. Tetap satu kolom, urutan kronologis dari atas. */}
          <Card>
            <CardBody>
              <PanelTitle icon={History}>Riwayat Status</PanelTitle>
              <div className="mt-4">
                <Timeline
                  status={visit.status}
                  createdAt={visit.created_at}
                  startDate={visit.start_date}
                  endDate={visit.end_date}
                  checkInAt={visit.check_in_at ?? null}
                  checkOutAt={visit.check_out_at ?? null}
                  statusNote={visit.status_note ?? null}
                  history={visit.history ?? null}
                  createdByName={visit.created_by_name ?? null}
                />
              </div>
            </CardBody>
          </Card>

          <VisitLogsTimeline
            visitId={visitId}
            logs={logsQuery.data ?? []}
            isPending={logsQuery.isPending}
            isError={logsQuery.isError}
            onRetry={() => void logsQuery.refetch()}
            before={visit.work_photos?.before ?? null}
            after={visit.work_photos?.after ?? null}
          />

          {/* Panel Informasi Lengkap */}
          <Card>
            <CardBody>
              <PanelTitle icon={MapPin}>Informasi Kunjungan</PanelTitle>
              <dl className="mt-4 divide-y divide-border-light">
                <InfoRow label="Vendor/Mitra" value={vendorCompany} />
                <InfoRow
                  label="Nama"
                  value={
                    <>
                      {vendorUser?.name}
                      <span className="block text-label text-ink-muted">
                        {vendorUser?.email}
                      </span>
                    </>
                  }
                />
                <InfoRow label="Lokasi" value={visit.location.name} />
                <InfoRow label="Keperluan" value={purposeChips} />
                {/* "Keperluan lain" (purpose_note) hanya bila terisi. */}
                {visit.purpose_note != null &&
                visit.purpose_note.trim() !== '' ? (
                  <InfoRow label="Keperluan lain" value={visit.purpose_note} />
                ) : null}
                <InfoRow
                  label="Rentang Waktu"
                  value={
                    <span className="tabular-nums">
                      {`${formatTanggalWaktu(visit.start_date)} – ${formatTanggalWaktu(visit.end_date)}`}
                    </span>
                  }
                />
                {/* Baris pelaku hanya bila backend mengirim namanya; kunjungan
                    tanpa enrichmen (mis. pratinjau daftar) menghilangkan baris,
                    bukan menampilkan UUID telanjang. */}
                {visit.created_by_name != null && visit.created_by_name !== '' ? (
                  <InfoRow
                    label="Diajukan oleh"
                    value={
                      visit.created_by_role_label != null &&
                      visit.created_by_role_label !== ''
                        ? `${visit.created_by_name} (${visit.created_by_role_label})`
                        : visit.created_by_name
                    }
                  />
                ) : null}
                {/* Pelaku check-in/out tidak ditampilkan di sini — tercatat di
                    node gerbang Riwayat Status ("diverifikasi oleh …") dan
                    lengkap di Riwayat Kunjungan. */}
                <InfoRow
                  label="Catatan"
                  value={
                    visit.notes !== null && visit.notes.trim() !== ''
                      ? visit.notes
                      : 'Tidak ada catatan.'
                  }
                />
                {visit.status === 'rescheduled' &&
                visit.status_note != null &&
                visit.status_note.trim() !== '' ? (
                  <InfoRow
                    label="Alasan Perubahan Jadwal"
                    value={visit.status_note}
                  />
                ) : null}
              </dl>
            </CardBody>
          </Card>

          {/* Panel Dokumen Surat Tugas */}
          <Card>
            <CardBody>
              <PanelTitle icon={FileText}>Dokumen Surat Tugas</PanelTitle>
              {/*
                Cek truthy (bukan `!== null`): string kosong sama saja tidak
                ada dokumen — jika tetap dirender, tautan akan membuka tab kosong.
              */}
              {visit.assignment_letter_url ? (
                <SuratTugasPanel visit={visit} />
              ) : (
                <p className="mt-4 rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
                  Belum ada dokumen surat tugas yang dilampirkan.
                </p>
              )}
            </CardBody>
          </Card>

          {/* Bukti Kerja — dua slot kondisi (sebelum/sesudah). Unggah hanya
              saat `visiting` dan hanya oleh pemilik/pembuat: vendor pemilik
              (`isOwnerVendor`) atau pembuat kunjungan (`isCreator`,
              `created_by` = id sesi) — BUKAN security dan BUKAN admin lain
              (petugas gerbang hanya verifikasi check-in/out). Kartu tetap
              menampilkan foto lama sesudah terkunci. */}
          <WorkPhotoCard
            visitId={visit.id}
            status={visit.status}
            before={visit.work_photos?.before ?? null}
            after={visit.work_photos?.after ?? null}
            canEdit={
              visit.status === 'visiting' && (isOwnerVendor || isCreator)
            }
            activeVisitLogId={activeVisitLogId}
          />

          {/* Daftar Anggota — permukaan ber-tint lembut (bukan kotak
              berborder) supaya deretan anggota terbaca sebagai kartu data,
              bukan tabel bersel. */}
          <Card>
            <CardBody>
              <PanelTitle icon={Users} trailing={<Badge tone="neutral">{visit.visitors.length}</Badge>}>
                Anggota
              </PanelTitle>
              {visit.visitors.length > 0 ? (
                <ul className="mt-4 flex flex-col gap-3">
                  {visit.visitors.map((visitor, index) => {
                    const selfieUrl = visitor.photo_url ?? null
                    return (
                      <li
                        key={`${index}-${visitor.id_number}`}
                        className="flex items-start gap-3 rounded-control bg-neutral-bg/70 p-3"
                      >
                        {selfieUrl !== null && selfieUrl !== '' ? (
                          <VisitFilePhoto
                            visitId={visit.id}
                            visitor={visitor}
                            variant="selfie"
                          />
                        ) : (
                          <VisitorPhoto
                            src={null}
                            visitorName={visitor.name}
                            variant="selfie"
                          />
                        )}
                        <VisitorContactRow
                          visitId={visit.id}
                          visitor={visitor}
                          canEdit={canEditVisitorContact}
                        />
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="mt-3 rounded-control bg-neutral-bg px-4 py-3 text-sm text-neutral-text">
                  Belum ada data anggota pada kunjungan ini.
                </p>
              )}
            </CardBody>
          </Card>

          {showDelete ? (
            <Card className="border-danger-text/20 bg-danger-bg/50">
              <CardBody>
                <PanelTitle icon={Trash2} tone="danger">
                  Zona Berbahaya
                </PanelTitle>
                <p className="mt-3 text-sm text-ink-secondary">
                  Hapus permanen kunjungan ini beserta seluruh datanya. Berlaku untuk status apa pun dan tidak dapat dibatalkan.
                </p>
                <Button
                  variant="danger"
                  className="mt-4"
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
      {completeOpen && (
        <ConfirmModal
          open
          title={`Selesaikan ${visit.visit_id}`}
          message={`Selesaikan kunjungan ${visit.visit_id}? Permit akan ditutup dan tidak dapat dipakai untuk check-in lagi.`}
          confirmLabel="Ya, Selesaikan"
          loading={completeMutation.isPending}
          onClose={() => setCompleteOpen(false)}
          onConfirm={() => {
            completeMutation.mutate(
              { visitId },
              {
                onSuccess: () => {
                  toast.success(`Kunjungan ${visit.visit_id} telah diselesaikan.`)
                  setCompleteOpen(false)
                  onRefresh()
                },
                onError: (error) => {
                  toast.error(apiErrorMessage(error))
                },
              },
            )
          }}
        />
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
