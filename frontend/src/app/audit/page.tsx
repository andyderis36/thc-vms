'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, Fingerprint, Inbox, Info, Server, Tag, UserRound } from 'lucide-react'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterResetButton } from '@/components/ui/FilterResetButton'
import { Input } from '@/components/ui/Input'
import { Pagination } from '@/components/ui/Pagination'
import { Select, type SelectOption } from '@/components/ui/Select'
import { Spinner } from '@/components/ui/Spinner'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { formatTanggalWaktu } from '@/features/visits/detail/Timeline'
import {
  useAuditLogsQuery,
  useManagedUsersQuery,
  usePendingApprovalCount,
} from '@/lib/api/hooks'
import type { AuditLog, AuditLogListParams } from '@/lib/api/types'
import { RequireRole } from '@/lib/auth/guards'
import { type StatusTone } from '@/lib/visits/status-badge'

// ---------------------------------------------------------------------------
// Helper murni (diekspor agar dapat diuji unit — lihat tests/audit-logs.test.ts)
// ---------------------------------------------------------------------------

/** Batas baris per halaman — selaras default `limit` backend (openapi §475). */
export const AUDIT_PAGE_LIMIT = 20

/** Label Bahasa Indonesia untuk 10 aksi MVP tertutup (domain `audit.go`). */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'auth.login.success': 'Masuk berhasil',
  'auth.login.failed': 'Masuk gagal',
  'user.create': 'Buat user',
  'user.update': 'Ubah user',
  'user.status': 'Ubah status user',
  'user.delete': 'Hapus user',
  'location.create': 'Buat fasilitas',
  'location.update': 'Ubah fasilitas',
  'location.delete': 'Hapus fasilitas',
  'visit.delete': 'Hapus kunjungan',
}

/** Label entitas yang tersentuh aksi (kontrak `AuditLog.entity`). */
export const AUDIT_ENTITY_LABEL: Record<string, string> = {
  auth: 'Autentikasi',
  user: 'Pengguna',
  location: 'Fasilitas',
  visit: 'Kunjungan',
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? action
}

export function auditEntityLabel(entity: string): string {
  return AUDIT_ENTITY_LABEL[entity] ?? entity
}

export function auditActionTone(action: string): StatusTone {
  if (action === 'auth.login.success') return 'success'
  if (action === 'auth.login.failed') return 'danger'
  if (action.endsWith('.delete')) return 'warning'
  return 'info'
}

/** Nama pelaku dari peta user; baris sistem (`null`) = "Sistem"; user terhapus = UUID pendek. */
export function auditActorLabel(
  userId: string | null,
  usersById: ReadonlyMap<string, string>,
): string {
  if (userId === null) return 'Sistem'
  const name = usersById.get(userId)
  if (name !== undefined && name !== '') return name
  return userId.slice(0, 8)
}

/** Ringkas metadata kunci→nilai untuk satu baris; kosong = strip. */
export function auditMetadataSummary(metadata: Record<string, string>): string {
  const entries = Object.entries(metadata)
  if (entries.length === 0) return '—'
  return entries.map(([key, value]) => `${key}: ${value}`).join(' · ')
}

export interface AuditFilter {
  /** UUID pelaku; sentinel `'all'` = semua pelaku (kontrak `user_id`). */
  userId: string
  /** `''` = semua entitas. */
  entity: string
  /** `''` = semua aksi. */
  action: string
  /** `YYYY-MM-DD`; `''` = tanpa batas bawah. */
  dateFrom: string
  /** `YYYY-MM-DD`; `''` = tanpa batas atas. */
  dateTo: string
}

export const EMPTY_AUDIT_FILTER: AuditFilter = {
  userId: 'all',
  entity: '',
  action: '',
  dateFrom: '',
  dateTo: '',
}

/**
 * Normalisasi filter UI menjadi query `GET /audit-logs` — string kosong,
 * whitespace, dan sentinel `'all'` dibuang agar tidak terkirim (kontrak §475).
 */
export function toAuditLogListParams(
  filter: AuditFilter,
  page: number,
): AuditLogListParams {
  const params: AuditLogListParams = { page, limit: AUDIT_PAGE_LIMIT }
  const userId = filter.userId.trim()
  if (userId !== '' && userId !== 'all') params.user_id = userId
  const entity = filter.entity.trim()
  if (entity !== '') params.entity = entity
  const action = filter.action.trim()
  if (action !== '') params.action = action
  const dateFrom = filter.dateFrom.trim()
  if (dateFrom !== '') params.date_from = dateFrom
  const dateTo = filter.dateTo.trim()
  if (dateTo !== '') params.date_to = dateTo
  return params
}

const ENTITY_OPTIONS: SelectOption[] = [
  { value: '', label: 'Semua Entitas' },
  ...Object.entries(AUDIT_ENTITY_LABEL).map(([value, label]) => ({ value, label })),
]

const ACTION_OPTIONS: SelectOption[] = [
  { value: '', label: 'Semua Aksi' },
  ...Object.entries(AUDIT_ACTION_LABEL).map(([value, label]) => ({ value, label })),
]

/**
 * Jejak audit lintas cabang (super_admin) — kontrak `GET /audit-logs`.
 * Guard penuh `RequireRole allow=['super_admin']` + `SuperadminShell`.
 */
export default function AuditPage() {
  return (
    <RequireRole allow={['super_admin']}>
      <AuditScreen />
    </RequireRole>
  )
}

function AuditScreen() {
  const [filter, setFilter] = useState<AuditFilter>(EMPTY_AUDIT_FILTER)
  const [page, setPage] = useState(1)

  const params = useMemo(() => toAuditLogListParams(filter, page), [filter, page])
  const auditQuery = useAuditLogsQuery(params)
  const usersQuery = useManagedUsersQuery({})
  const { pendingCount } = usePendingApprovalCount()

  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data])
  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user.name])),
    [users],
  )
  const actorOptions = useMemo<SelectOption[]>(() => {
    const sorted = [...users].sort((a, b) => a.name.localeCompare(b.name, 'id'))
    return [
      { value: 'all', label: 'Semua Pelaku' },
      ...sorted.map((user) => ({ value: user.id, label: user.name })),
    ]
  }, [users])

  const updateFilter = (patch: Partial<AuditFilter>): void => {
    setFilter((prev) => ({ ...prev, ...patch }))
    setPage(1)
  }

  // Reset menyeluruh: pakai konstanta `EMPTY_AUDIT_FILTER` (bukan objek
  // inline baru) agar sentinel userId 'all' tak pernah menyimpang, dan
  // kembali ke halaman 1 — tanpa ini, user yang menyaring dari halaman 5
  // bisa terjebak di halaman kosong setelah hasil menyusut drastis.
  const handleResetFilters = (): void => {
    setFilter(EMPTY_AUDIT_FILTER)
    setPage(1)
  }

  const items = auditQuery.data?.items ?? []
  const total = auditQuery.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_LIMIT))
  const hasActiveFilter =
    filter.userId !== 'all' ||
    filter.entity !== '' ||
    filter.action !== '' ||
    filter.dateFrom !== '' ||
    filter.dateTo !== ''
  const rangeStart = total > 0 ? (page - 1) * AUDIT_PAGE_LIMIT + 1 : 0
  const rangeEnd = total > 0 ? rangeStart + items.length - 1 : 0

  const emptyTitle = hasActiveFilter
    ? 'Tidak ada jejak audit yang cocok'
    : 'Belum ada jejak audit'
  const emptyDescription = hasActiveFilter
    ? 'Coba ubah filter pelaku, entitas, aksi, atau rentang tanggal.'
    : 'Setiap aksi administratif akan tercatat otomatis di sini.'

  return (
    <SuperadminShell pendingCount={pendingCount} activeHref="/audit">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-ink">Jejak Audit</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Lacak aktivitas sistem lintas cabang: siapa, apa, dan kapan.
        </p>
      </div>

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-44 flex-1 sm:w-56 sm:flex-none">
          <Select
            label="Pelaku"
            options={actorOptions}
            value={filter.userId}
            onChange={(event) => updateFilter({ userId: event.target.value })}
          />
        </div>
        <div className="min-w-40 flex-1 sm:w-48 sm:flex-none">
          <Select
            label="Entitas"
            options={ENTITY_OPTIONS}
            value={filter.entity}
            onChange={(event) => updateFilter({ entity: event.target.value })}
          />
        </div>
        <div className="min-w-44 flex-1 sm:w-56 sm:flex-none">
          <Select
            label="Aksi"
            options={ACTION_OPTIONS}
            value={filter.action}
            onChange={(event) => updateFilter({ action: event.target.value })}
          />
        </div>
        <div className="min-w-36 flex-1 sm:w-44 sm:flex-none">
          <Input
            label="Dari Tanggal"
            type="date"
            value={filter.dateFrom}
            max={filter.dateTo !== '' ? filter.dateTo : undefined}
            onChange={(event) => updateFilter({ dateFrom: event.target.value })}
          />
        </div>
        <div className="min-w-36 flex-1 sm:w-44 sm:flex-none">
          <Input
            label="Sampai Tanggal"
            type="date"
            value={filter.dateTo}
            min={filter.dateFrom !== '' ? filter.dateFrom : undefined}
            onChange={(event) => updateFilter({ dateTo: event.target.value })}
          />
        </div>
        <FilterResetButton onReset={handleResetFilters} disabled={!hasActiveFilter} />
      </div>

      <div className="mt-4">
        {auditQuery.isPending ? (
          <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat jejak audit…
          </div>
        ) : auditQuery.isError ? (
          <div className="card p-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-danger-text">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              Gagal memuat jejak audit
            </p>
            <p className="mt-2 text-sm text-ink-secondary">
              {apiErrorMessage(auditQuery.error)}
            </p>
            <Button
              variant="secondary"
              className="mt-4 min-h-touch"
              onClick={() => void auditQuery.refetch()}
            >
              Coba Lagi
            </Button>
          </div>
        ) : (
          <>
            {items.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon={<Inbox aria-hidden="true" className="size-8" />}
                  title={emptyTitle}
                  description={emptyDescription}
                />
              </div>
            ) : (
              <>
                <AuditTable items={items} usersById={usersById} />
                <AuditCards items={items} usersById={usersById} />
              </>
            )}

            {total > 0 ? (
              <Pagination
                page={page}
                totalPages={totalPages}
                onPageChange={setPage}
                className="mt-4"
              />
            ) : null}
          </>
        )}
      </div>
    </SuperadminShell>
  )
}

// ---------------------------------------------------------------------------
// Tabel desktop (>= 1024px) + kartu responsif: ponsel (< 768px) tumpukan
// vertikal 1 kolom, tablet (768px - 1023px) grid 2 kolom — tanpa scroll.
// ---------------------------------------------------------------------------

interface AuditListProps {
  items: AuditLog[]
  usersById: ReadonlyMap<string, string>
}

function AuditTable({ items, usersById }: AuditListProps) {
  return (
    <div className="card hidden overflow-hidden lg:block">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr>
            {[
              { label: 'Waktu', width: 'w-[18%]' },
              { label: 'Pelaku', width: 'w-[18%]' },
              { label: 'Aksi', width: 'w-[14%]' },
              { label: 'Entitas', width: 'w-[20%]' },
              { label: 'IP', width: 'w-[12%]' },
              { label: 'Keterangan', width: 'w-[18%]' },
            ].map((header) => (
              <th
                key={header.label}
                scope="col"
                className={`${header.width} border-b border-border-light bg-brand/5 px-2 sm:px-3 lg:px-6 py-3 text-xs sm:text-sm font-semibold text-ink-secondary`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-light">
          {items.map((log) => (
            <tr
              key={log.id}
              className="transition-colors hover:bg-brand/5"
            >
              <td className="px-2 sm:px-3 lg:px-6 py-3">
                <p className="whitespace-nowrap text-xs sm:text-sm text-ink">
                  {formatTanggalWaktu(log.timestamp)}
                </p>
              </td>
              <td className="px-2 sm:px-3 lg:px-6 py-3">
                <p
                  className="truncate text-xs sm:text-sm font-semibold text-ink"
                  title={log.user_id ?? undefined}
                >
                  {auditActorLabel(log.user_id, usersById)}
                </p>
              </td>
              <td className="px-2 sm:px-3 lg:px-6 py-3">
                <Badge tone={auditActionTone(log.action)}>
                  {auditActionLabel(log.action)}
                </Badge>
              </td>
              <td className="px-2 sm:px-3 lg:px-6 py-3">
                <Badge tone="neutral">{auditEntityLabel(log.entity)}</Badge>
                {log.entity_id !== null ? (
                  <p className="mt-1 truncate text-xs text-ink-muted" title={log.entity_id}>
                    {log.entity_id}
                  </p>
                ) : null}
              </td>
              <td className="px-2 sm:px-3 lg:px-6 py-3">
                <p className="truncate text-xs sm:text-sm tabular-nums text-ink-secondary" title={log.ip}>
                  {log.ip !== '' ? log.ip : '—'}
                </p>
              </td>
              <td className="px-2 sm:px-3 lg:px-6 py-3">
                <p
                  className="truncate text-xs sm:text-sm text-ink-secondary"
                  title={auditMetadataSummary(log.metadata)}
                >
                  {auditMetadataSummary(log.metadata)}
                </p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AuditCards({ items, usersById }: AuditListProps) {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden">
      {items.map((log) => (
        <li key={log.id} className="card flex flex-col p-4">
          <div className="flex items-start justify-between gap-3">
            <Badge tone={auditActionTone(log.action)}>
              {auditActionLabel(log.action)}
            </Badge>
            <p className="shrink-0 text-xs text-ink-muted">
              {formatTanggalWaktu(log.timestamp)}
            </p>
          </div>
          <div className="mt-3 flex flex-col gap-2 text-sm text-ink-secondary">
            <p className="flex items-start gap-2">
              <UserRound
                className="mt-0.5 size-4 shrink-0 text-ink-muted"
                aria-hidden="true"
              />
              <span className="min-w-0 wrap-anywhere text-ink">
                {auditActorLabel(log.user_id, usersById)}
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Tag className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="min-w-0 wrap-anywhere">
                {auditEntityLabel(log.entity)}
                {log.entity_id !== null ? ` · ${log.entity_id}` : ''}
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Server className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="min-w-0 tabular-nums wrap-anywhere">
                {log.ip !== '' ? log.ip : '—'}
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Fingerprint
                className="mt-0.5 size-4 shrink-0 text-ink-muted"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate wrap-anywhere" title={log.user_agent}>
                {log.user_agent !== '' ? log.user_agent : '—'}
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="min-w-0 wrap-anywhere">
                {auditMetadataSummary(log.metadata)}
              </span>
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
