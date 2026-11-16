'use client'

import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { ProfileBackLink } from '@/features/profile/components/ProfileBackLink'
import { apiErrorMessage } from '@/features/visits/components/ApproveModal'
import { RequireRole } from '@/lib/auth/guards'
import * as apiHooks from '@/lib/api/hooks'
import type { NotificationChannelToggle, NotificationEvent, NotificationToggle } from '@/lib/api/types'
import { NOTIFICATION_EVENT_LABEL } from '@/lib/api/types'
import {
  TABLE_CARD_LIST_CLASS,
  TABLE_CLASS,
  TABLE_TD_CLASS,
  TABLE_TH_CLASS,
  TABLE_WRAPPER_CLASS,
} from '@/lib/table-styles'

function pickHook(...names: string[]): (...args: unknown[]) => unknown {
  for (const name of names) {
    const candidate = (apiHooks as Record<string, unknown>)[name]
    if (typeof candidate === 'function') return candidate as (...args: unknown[]) => unknown
  }
  return (apiHooks as Record<string, unknown>).useNotificationSettingsQuery as (...args: unknown[]) => unknown
}

const useSettingsQuery = pickHook(
  'useNotificationSettingsQuery',
  'useNotificationMatrixQuery',
  'useNotificationSettings',
  'useNotificationsSettingsQuery',
)

const useSettingsMutation = pickHook(
  'useUpdateNotificationSettingsMutation',
  'useUpdateNotificationMatrixMutation',
  'useUpdateNotificationSettings',
  'useUpdateNotificationsSettingsMutation',
)

const usePendingCountHook =
  typeof (apiHooks as Record<string, unknown>).usePendingApprovalCount === 'function'
    ? ((apiHooks as Record<string, unknown>).usePendingApprovalCount as () => { pendingCount?: number })
    : () => ({ pendingCount: 0 })

const EVENT_ORDER: NotificationEvent[] = [
  'visit_requested',
  'visit_approved',
  'visit_rejected',
  'visit_rescheduled',
  'visit_check_in',
  'visit_check_out',
  'visit_cancelled',
  'visit_auto_cancelled',
  'visit_reminder',
]

function labelFor(event: NotificationEvent): string {
  return (NOTIFICATION_EVENT_LABEL as Record<string, string>)[event] ?? event
}

/**
 * Matriks efektif: sel tanpa kaki pengiriman tidak dirender (placeholder
 * "-") dan dimatikan. Peta `applicable` datang dari server, jadi halaman ini
 * tidak pernah menebak nama peristiwa. Server juga memublikasikan keadaan
 * efektif, tetapi sel yang tersimpan ON di sel tak berlaku akan ditolak PUT —
 * menyalin dengan pemaskean membuat draft dan payload konsisten dengan apa
 * yang benar-benar dikirim.
 */
function effectiveToggles(toggles: NotificationToggle[]): NotificationToggle[] {
  return toggles.map((t) => ({
    ...t,
    in_app: maskChannel(t.in_app, t.applicable?.in_app),
    email: maskChannel(t.email, t.applicable?.email),
    ...(t.applicable
      ? { applicable: { in_app: { ...t.applicable.in_app }, email: { ...t.applicable.email } } }
      : null),
  }))
}

function maskChannel(
  toggle: NotificationChannelToggle,
  applicable: NotificationChannelToggle | undefined,
): NotificationChannelToggle {
  if (!applicable) return toggle
  return { staff: toggle.staff && applicable.staff, vendor: toggle.vendor && applicable.vendor }
}

function isApplicable(
  toggle: NotificationToggle,
  channel: 'in_app' | 'email',
  audience: 'staff' | 'vendor',
): boolean {
  const cell = toggle.applicable?.[channel]?.[audience]
  return cell ?? true
}

function cellTitle(toggle: NotificationToggle): string | undefined {
  return toggle.mandatory ? 'Wajib sistem' : undefined
}

interface SettingsData {
  toggles: NotificationToggle[]
  version: number
}

interface QueryResult {
  data?: SettingsData | null
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => void | Promise<unknown>
}

interface MutationResult {
  mutate?: (body: { toggles: NotificationToggle[]; version: number }, opts?: { onSuccess?: (d: unknown) => void; onError?: (e: unknown) => void }) => void
  mutateAsync?: (body: { toggles: NotificationToggle[]; version: number }) => Promise<unknown>
  isPending: boolean
}

export default function SettingsNotificationsPage() {
  return (
    <RequireRole allow={['super_admin']}>
      <SettingsNotificationsScreen />
    </RequireRole>
  )
}

function SettingsNotificationsScreen() {
  const { pendingCount = 0 } = usePendingCountHook() ?? {}
  const query = useSettingsQuery() as QueryResult
  const mutation = useSettingsMutation() as MutationResult

  const [draft, setDraft] = useState<NotificationToggle[] | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [seenData, setSeenData] = useState<SettingsData | null | undefined>(undefined)

  if (query.data && query.data !== seenData) {
    setSeenData(query.data)
    setDraft(effectiveToggles(query.data.toggles))
    setVersion(query.data.version)
  }

  const handleToggle = (
    event: NotificationEvent,
    channel: 'in_app' | 'email',
    audience: 'staff' | 'vendor',
    value: boolean,
  ): void => {
    setDraft((prev) =>
      prev
        ? prev.map((t) =>
            t.event === event
              ? { ...t, [channel]: { ...t[channel], [audience]: value } }
              : t,
          )
        : prev,
    )
  }

  const handleSave = async (): Promise<void> => {
    if (!draft || version === null) return
    const payload = { toggles: effectiveToggles(draft), version }
    const onSuccess = (data: unknown): void => {
      const d = data as SettingsData | undefined
      if (d?.toggles) setDraft(effectiveToggles(d.toggles))
      if (typeof d?.version === 'number') setVersion(d.version)
    }
    const onError = (err: unknown): void => {
      const status = (err as { status?: number })?.status
      if (status === 409) {
        if (typeof (toast as { error?: unknown }).error === 'function') {
          ;(toast as { error: (m: string) => void }).error('Versi basi — memuat ulang…')
        } else if (typeof toast === 'function') {
          ;(toast as (m: string) => void)('Versi basi — memuat ulang…')
        }
        if (query.data) {
          setDraft(effectiveToggles(query.data.toggles))
          setVersion(query.data.version)
        }
        void query.refetch()
      } else {
        const msg = apiErrorMessage(err as never)
        if (typeof (toast as { error?: unknown }).error === 'function') {
          ;(toast as { error: (m: string) => void }).error(msg)
        } else if (typeof toast === 'function') {
          ;(toast as (m: string) => void)(msg)
        }
      }
    }
    try {
      if (typeof mutation.mutate === 'function') {
        mutation.mutate(payload, { onSuccess, onError })
      } else if (typeof mutation.mutateAsync === 'function') {
        const data = await mutation.mutateAsync(payload)
        onSuccess(data)
      }
    } catch (err) {
      onError(err)
    }
  }

  const rows = draft ?? (query.data ? effectiveToggles(query.data.toggles) : [])

  return (
    <SuperadminShell pendingCount={pendingCount} activeHref="/settings/notifications">
      <ProfileBackLink href="/settings" label="Pengaturan" />
      <div className="mb-5 mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-ink">Pengaturan Notifikasi</h1>
            <Badge tone="info">{rows.length} peristiwa</Badge>
          </div>
          <p className="mt-1 text-sm text-ink-secondary">
            Atur kanal notifikasi per peristiwa. Baris bertanda Wajib sistem tidak dapat diubah.
          </p>
        </div>
        <Button
          className="min-h-touch"
          onClick={() => void handleSave()}
          loading={mutation.isPending}
          disabled={query.isPending || query.isError || !draft}
        >
          Simpan
        </Button>
      </div>

      {query.isPending ? (
        <div className="card flex items-center justify-center gap-3 py-12 text-sm text-ink-secondary">
          <Spinner size="sm" />
          Memuat pengaturan notifikasi.
        </div>
      ) : query.isError ? (
        <div className="card p-6">
          <p className="flex items-center gap-2 text-sm font-semibold text-danger-text">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            Gagal memuat pengaturan notifikasi
          </p>
          <p className="mt-2 text-sm text-ink-secondary">{apiErrorMessage(query.error as never)}</p>
          <Button variant="secondary" className="mt-4 min-h-touch" onClick={() => void query.refetch()}>
            Coba Lagi
          </Button>
        </div>
      ) : (
        <>
          <div className={TABLE_WRAPPER_CLASS}>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  {['Peristiwa', 'Dalam Aplikasi · Staf', 'Dalam Aplikasi · Vendor', 'Email · Staf', 'Email · Vendor', 'Wajib Sistem', 'Audit'].map((h) => (
                    <th key={h} scope="col" className={TABLE_TH_CLASS}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-light">
                {EVENT_ORDER.map((event) => {
                  const toggle = rows.find((t) => t.event === event)
                  if (!toggle) return null
                  const mandatory = toggle.mandatory
                  return (
                    <tr key={event} className="transition-colors hover:bg-brand/5">
                      <td className={TABLE_TD_CLASS}>
                        <span className="text-sm font-semibold text-ink">{labelFor(event)}</span>
                      </td>
                      {([['in_app', 'staff'], ['in_app', 'vendor'], ['email', 'staff'], ['email', 'vendor']] as const).map(([channel, audience]) => {
                        const checked = channel === 'in_app' ? toggle.in_app[audience] : toggle.email[audience]
                        const applicable = isApplicable(toggle, channel, audience)
                        return (
                          <td key={`${channel}-${audience}`} className={`${TABLE_TD_CLASS} text-center`}>
                            {applicable ? (
                              <input
                                type="checkbox"
                                className="size-5 rounded-control accent-brand"
                                checked={checked}
                                disabled={mandatory}
                                title={cellTitle(toggle)}
                                onChange={(e) =>
                                  handleToggle(event, channel, audience, e.target.checked)
                                }
                                aria-label={`${labelFor(event)} ${channel} ${audience}`}
                              />
                            ) : (
                              <span className="text-xs text-ink-muted">-</span>
                            )}
                          </td>
                        )
                      })}
                      <td className={TABLE_TD_CLASS}>
                        {mandatory ? (
                          <Badge tone="warning" className="rounded-badge">Wajib sistem</Badge>
                        ) : (
                          <span className="text-xs text-ink-muted">-</span>
                        )}
                      </td>
                      <td className={TABLE_TD_CLASS}>
                        <a href="/audit" className="text-sm text-brand hover:underline">
                          Jejak audit
                        </a>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <ul className={TABLE_CARD_LIST_CLASS}>
            {EVENT_ORDER.map((event) => {
              const toggle = rows.find((t) => t.event === event)
              if (!toggle) return null
              const mandatory = toggle.mandatory
              return (
                <li key={event} className="card flex flex-col gap-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">{labelFor(event)}</p>
                    {mandatory ? (
                      <Badge tone="warning" className="rounded-badge">Wajib sistem</Badge>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(['in_app', 'email'] as const).map((channel) =>
                      (['staff', 'vendor'] as const).map((audience) => {
                        const checked = channel === 'in_app' ? toggle.in_app[audience] : toggle.email[audience]
                        const applicable = isApplicable(toggle, channel, audience)
                        const cellLabel = `${channel === 'in_app' ? 'Dalam aplikasi' : 'Email'} · ${audience === 'staff' ? 'Staf' : 'Vendor'}`
                        const cellClass =
                          'flex min-h-touch items-center gap-2 rounded-control border border-border-light px-3 py-2 text-sm'
                        if (!applicable) {
                          return (
                            <div key={`${channel}-${audience}`} className={cellClass}>
                              <span className="text-xs text-ink-muted">-</span>
                              <span className="text-xs text-ink-secondary">{cellLabel}</span>
                            </div>
                          )
                        }
                        return (
                          <label key={`${channel}-${audience}`} className={cellClass}>
                            <input
                              type="checkbox"
                              className="size-5 rounded-control accent-brand"
                              checked={checked}
                              disabled={mandatory}
                              title={cellTitle(toggle)}
                              onChange={(e) =>
                                handleToggle(event, channel, audience, e.target.checked)
                              }
                            />
                            <span className="text-xs text-ink-secondary">{cellLabel}</span>
                          </label>
                        )
                      }),
                    )}
                  </div>
                  <a href="/audit" className="text-sm text-brand hover:underline">
                    Jejak audit
                  </a>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </SuperadminShell>
  )
}
