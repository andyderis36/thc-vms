'use client'

import { useState } from 'react'
import { AlertTriangle, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { ProfileBackLink } from '@/features/profile/components/ProfileBackLink'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { formatTanggalWaktu } from '@/features/visits/detail/Timeline'
import { RequireRole } from '@/lib/auth/guards'
import {
  useMailLogDetailQuery,
  useMailLogsQuery,
  usePendingApprovalCount,
  useSendTestMailMutation,
  useSystemSettingsQuery,
} from '@/lib/api/hooks'
import {
  TABLE_CARD_LIST_CLASS,
  TABLE_CLASS,
  TABLE_TD_CLASS,
  TABLE_TH_CLASS,
  TABLE_WRAPPER_CLASS,
} from '@/lib/table-styles'

export default function SettingsMailLogsPage() {
  return (
    <RequireRole allow={['super_admin']}>
      <SettingsMailLogsScreen />
    </RequireRole>
  )
}

function SettingsMailLogsScreen() {
  const { pendingCount = 0 } = usePendingApprovalCount() ?? {}

  const [mailStatus, setMailStatus] = useState<string>('')
  const [mailPage, setMailPage] = useState<number>(1)
  const [selectedMailId, setSelectedMailId] = useState<string | null>(null)

  const systemQuery = useSystemSettingsQuery() as {
    data?: {
      mailer?: { queueDepth?: number; queue_depth?: number; dropped?: number } | null
    } | null
    isPending: boolean
    isError: boolean
    error: unknown
    refetch: () => void | Promise<unknown>
  }
  const testMailMutation = useSendTestMailMutation() as {
    mutate?: (opts?: { onSuccess?: (d: unknown) => void; onError?: (e: unknown) => void }) => void
    mutateAsync?: () => Promise<unknown>
    isPending: boolean
  }

  const handleSendTestMail = (): void => {
    const onSuccess = (): void => {
      toast.success('Email tes berhasil dikirim.')
    }
    const onError = (err: unknown): void => {
      toast.error(apiErrorMessage(err as never))
    }
    try {
      if (typeof testMailMutation.mutate === 'function') {
        const m = testMailMutation.mutate as (...a: unknown[]) => unknown
        m({ onSuccess, onError }, { onSuccess, onError })
      } else if (typeof testMailMutation.mutateAsync === 'function') {
        void testMailMutation.mutateAsync().then(onSuccess).catch(onError)
      }
    } catch (err) {
      onError(err)
    }
  }

  const mailLogsQuery = useMailLogsQuery({ status: mailStatus, page: mailPage, limit: 20 }) as {
    data?: { items?: unknown[]; total?: number } | null
    isPending: boolean
    isError: boolean
    error: unknown
    refetch: () => void | Promise<unknown>
  }

  const mailLogDetailQuery = useMailLogDetailQuery(selectedMailId) as {
    data?: Record<string, unknown> | null
    isPending: boolean
    isError: boolean
    error: unknown
    refetch: () => void | Promise<unknown>
  }

  const items = (mailLogsQuery.data?.items ?? []) as unknown[]

  return (
    <SuperadminShell pendingCount={pendingCount}>
      <ProfileBackLink href="/settings" label="Pengaturan" />
      <div className="mb-5 mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-ink">Log Email</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Riwayat pengiriman email notifikasi, status antrean mailer, dan kirim email tes.
          </p>
        </div>
      </div>

      <div className="card mb-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">Status Mailer</h2>
            <p className="mt-1 text-sm text-ink-secondary">
              Antrean pengiriman dan email yang dibuang karena antrean penuh.
            </p>
          </div>
          <Button
            className="min-h-touch"
            onClick={() => void handleSendTestMail()}
            loading={testMailMutation.isPending}
          >
            <Mail className="size-4" aria-hidden="true" />
            Kirim email tes
          </Button>
        </div>
        {systemQuery.isPending ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat status mailer.
          </div>
        ) : systemQuery.isError ? (
          <p className="mt-3 text-sm text-ink-secondary">
            Tidak dapat memuat status mailer.
          </p>
        ) : (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div className="rounded-control border border-border-light p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Antrean Mailer</p>
              <p className="mt-1 text-2xl font-bold text-ink">
                {systemQuery.data?.mailer?.queueDepth ?? systemQuery.data?.mailer?.queue_depth ?? 0}
              </p>
            </div>
            <div className="rounded-control border border-border-light p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Dropped</p>
              <p className="mt-1 text-2xl font-bold text-ink">
                {systemQuery.data?.mailer?.dropped ?? 0}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {[
          { value: '', label: 'Semua' },
          { value: 'sent', label: 'Terkirim' },
          { value: 'failed', label: 'Gagal' },
          { value: 'queued', label: 'Antre' },
        ].map((opt) => (
          <button
            key={opt.value || 'all'}
            type="button"
            className={`min-h-touch rounded-control border px-3 py-1.5 text-sm font-medium ${
              mailStatus === opt.value
                ? 'border-brand bg-brand text-white'
                : 'border-border-light bg-surface text-ink'
            }`}
            onClick={() => {
              setMailStatus(opt.value)
              setMailPage(1)
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {mailLogsQuery.isPending ? (
        <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
          <Spinner size="sm" />
          Memuat log email.
        </div>
      ) : mailLogsQuery.isError ? (
        <div className="card p-6">
          <EmptyState
            icon={<AlertTriangle aria-hidden="true" className="size-8" />}
            title="Tidak dapat memuat log email"
            description="Periksa koneksi atau izin akses Anda."
          />
          <Button variant="secondary" className="mt-4 min-h-touch" onClick={() => void mailLogsQuery.refetch()}>
            Coba Lagi
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Mail aria-hidden="true" className="size-8" />}
            title="Belum ada log email"
            description="Log pengiriman email akan muncul di sini."
          />
        </div>
      ) : (
        <>
          <div className={TABLE_WRAPPER_CLASS}>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  {[
                    { label: 'Waktu', width: 'w-[18%]' },
                    { label: 'Penerima', width: 'w-[22%]' },
                    { label: 'Subjek', width: 'w-[24%]' },
                    { label: 'Template', width: 'w-[12%]' },
                    { label: 'Status', width: 'w-[12%]' },
                    { label: 'Aksi', width: 'w-[12%]' },
                  ].map((h) => (
                    <th key={h.label} scope="col" className={`${TABLE_TH_CLASS} ${h.width}`}>
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-light">
                {items.map((raw) => {
                  const item = raw as Record<string, unknown>
                  const id = String(item.id ?? '')
                  const status = String(item.status ?? '')
                  const subject = String(item.subject ?? '')
                  const to = Array.isArray(item.to) ? (item.to as unknown[]).map(String) : []
                  const createdAt = String(item.createdAt ?? item.created_at ?? '')
                  const template = String(item.template ?? '')
                  return (
                    <tr
                      key={id}
                      className="cursor-pointer transition-colors hover:bg-brand/5"
                      onClick={() => setSelectedMailId(id)}
                    >
                      <td className={`${TABLE_TD_CLASS} whitespace-nowrap`}>
                        {createdAt ? formatTanggalWaktu(createdAt) : '—'}
                      </td>
                      <td className={TABLE_TD_CLASS}>
                        <p className="truncate" title={to.join(', ')}>
                          {to.join(', ')}
                        </p>
                      </td>
                      <td className={TABLE_TD_CLASS}>
                        <p className="truncate" title={subject}>
                          {subject}
                        </p>
                      </td>
                      <td className={TABLE_TD_CLASS}>
                        <p className="truncate" title={template}>
                          {template}
                        </p>
                      </td>
                      <td className={TABLE_TD_CLASS}>
                        <Badge tone={status === 'sent' ? 'success' : status === 'failed' ? 'danger' : 'warning'} className="rounded-badge">
                          {status === 'sent' ? 'Terkirim' : status === 'failed' ? 'Gagal' : 'Antre'}
                        </Badge>
                      </td>
                      <td className={TABLE_TD_CLASS}>
                        <button
                          type="button"
                          className="text-sm text-brand hover:underline"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedMailId(id)
                          }}
                        >
                          Lihat
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <ul className={TABLE_CARD_LIST_CLASS}>
            {items.map((raw) => {
              const item = raw as Record<string, unknown>
              const id = String(item.id ?? '')
              const status = String(item.status ?? '')
              const subject = String(item.subject ?? '')
              const to = Array.isArray(item.to) ? (item.to as unknown[]).map(String) : []
              const createdAt = String(item.createdAt ?? item.created_at ?? '')
              const template = String(item.template ?? '')
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="card flex w-full flex-col gap-2 p-4 text-left"
                    onClick={() => setSelectedMailId(id)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={subject}>
                        {subject}
                      </p>
                      <Badge tone={status === 'sent' ? 'success' : status === 'failed' ? 'danger' : 'warning'} className="rounded-badge">
                        {status === 'sent' ? 'Terkirim' : status === 'failed' ? 'Gagal' : 'Antre'}
                      </Badge>
                    </div>
                    <p className="break-all text-xs text-ink-secondary" title={to.join(', ')}>
                      {to.join(', ')}
                    </p>
                    <p className="truncate text-xs text-ink-muted" title={template}>
                      {template}
                    </p>
                    <p className="text-xs text-ink-muted">{createdAt ? formatTanggalWaktu(createdAt) : '—'}</p>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <Modal open={selectedMailId !== null} onClose={() => setSelectedMailId(null)} title="Detail Log Email">
        {mailLogDetailQuery.isPending ? (
          <div className="flex items-center justify-center gap-3 py-8 text-sm text-ink-secondary">
            <Spinner size="sm" />
            Memuat detail.
          </div>
        ) : mailLogDetailQuery.isError ? (
          <div>
            <EmptyState
              icon={<AlertTriangle aria-hidden="true" className="size-8" />}
              title="Tidak dapat memuat detail"
              description="Periksa koneksi atau izin akses Anda."
            />
            <Button variant="secondary" className="mt-4 min-h-touch" onClick={() => void mailLogDetailQuery.refetch()}>
              Coba Lagi
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {(() => {
              const d = (mailLogDetailQuery.data ?? {}) as Record<string, unknown>
              const to = Array.isArray(d.to) ? (d.to as unknown[]).map(String) : []
              const bcc = Array.isArray(d.bcc) ? (d.bcc as unknown[]).map(String) : []
              const status = String(d.status ?? '')
              const textBody = String(d.textBody ?? d.text_body ?? '')
              const createdAt = String(d.createdAt ?? d.created_at ?? '')
              const sentAt = String(d.sentAt ?? d.sent_at ?? '')
              return (
                <>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Penerima</p>
                    <p className="mt-1 break-all text-sm text-ink">{to.join(', ')}</p>
                  </div>
                  {bcc.length > 0 ? (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Bcc (tersembunyi)</p>
                      <p className="mt-1 break-all text-sm text-ink">{bcc.join(', ')}</p>
                    </div>
                  ) : null}
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Subjek</p>
                    <p className="mt-1 text-sm text-ink">{String(d.subject ?? '')}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Template</p>
                    <p className="mt-1 text-sm text-ink">{String(d.template ?? '')}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Status</p>
                    <Badge tone={status === 'sent' ? 'success' : status === 'failed' ? 'danger' : 'warning'} className="rounded-badge">
                      {status === 'sent' ? 'Terkirim' : status === 'failed' ? 'Gagal' : 'Antre'}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Percobaan</p>
                    <p className="mt-1 text-sm text-ink">{String(d.attempts ?? '')}</p>
                  </div>
                  {d.error ? (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Error</p>
                      <p className="mt-1 text-sm text-danger-text">{String(d.error)}</p>
                    </div>
                  ) : null}
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Dibuat</p>
                    <p className="mt-1 text-sm text-ink">{createdAt ? formatTanggalWaktu(createdAt) : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Terkirim</p>
                    <p className="mt-1 text-sm text-ink">{sentAt ? formatTanggalWaktu(sentAt) : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Isi Teks</p>
                    <pre className="mt-1 whitespace-pre-wrap rounded-control border border-border-light bg-muted p-3 text-xs text-ink">{textBody}</pre>
                  </div>
                </>
              )
            })()}
          </div>
        )}
      </Modal>
    </SuperadminShell>
  )
}
