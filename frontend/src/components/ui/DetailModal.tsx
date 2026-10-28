'use client'

import { useEffect, useRef, type ReactNode } from 'react'

import { Button } from './Button'
import { Modal } from './Modal'

/**
 * Satu baris label→nilai pada daftar detail.
 *
 * `value` boleh `ReactNode` (teks polos, pill status, badge peran) — modal
 * ini TIDAK pernah memuat input, jadi nilainya murni tampilan.
 */
export interface DetailField {
  label: string
  value: ReactNode
}

export interface DetailModalProps {
  /** Judul dialog, mis. "Detail User". */
  title: string
  /** Baris pengenal di bawah judul, mis. nama record. */
  subtitle?: string
  /**
   * Slot identitas opsional pada baris header, di samping `subtitle`
   * (mis. `<UserAvatar name={record.name} avatarUrl={record.avatar_url} />`).
   * Absen (`undefined`/`null`) ⇒ TIDAK ada elemen ekstra: markup & spasi
   * baris subtitle persis seperti sebelum slot ini ada (kompat mundur).
   */
  avatar?: ReactNode
  /** Baris label→nilai berurutan; label diasumsikan unik per daftar. */
  fields: DetailField[]
  /** Dipanggil saat modal ditutup (Escape, klik overlay, atau tombol Tutup). */
  onClose: () => void
}

/** Placeholder nilai kosong — strip, bukan sel kosong. */
export const DETAIL_EMPTY_PLACEHOLDER = '—'

/**
 * Nilai yang dianggap tidak ada: `null`, `undefined`, string kosong (atau
 * hanya spasi), dan `false` (React tidak merender `false` sama sekali).
 * Angka `0` BUKAN kosong — itu nilai yang sah (mis. jumlah item).
 */
export function isEmptyDetailValue(value: ReactNode): boolean {
  if (value === null || value === undefined || value === false) return true
  if (typeof value === 'string') return value.trim() === ''
  return false
}

/**
 * Elemen yang bisa menerima fokus di dalam dialog — dipakai jebakan fokus.
 * `tabindex="-1"` sengaja dikecualikan: wadahnya hanya tempat fokus awal.
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Modal detail READ-ONLY — satu permukaan generik untuk "lihat seluruh
 * field" di halaman back-office (/coordinators, /vendor-registrations, /facilities, /security).
 *
 * Dibangun di atas primitif `Modal` yang sudah ada (bukan dialog kedua):
 *  - `Modal` menangani Escape, klik overlay, dan `role="dialog"` +
 *    `aria-modal="true"` + `aria-labelledby` ke judul.
 *  - Isinya hanya `<dl>` label→nilai. Tidak ada input, tidak ada tombol
 *    submit; satu-satunya kontrol adalah tombol tutup.
 *  - Nilai panjang (email, NIK, alamat) MEMILIT, bukan dipotong: ini tampilan
 *    baca, operator wajib melihat nilai utuh.
 *  - Nilai kosong → strip (`—`) yang redup, tak pernah sel kosong.
 *
 * Catatan aksesibilitas: `Modal` TIDAWAKAN menjebak fokus (tak ada focus
 * trap) dan tak memindahkan fokus ke dalam dialog. Keduanya ditutup di sini:
 * fokus awal masuk ke area isi, dan Tab diputar di dalam dialog.
 */
export function DetailModal({ title, subtitle, avatar, fields, onClose }: DetailModalProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const hasSubtitle = subtitle !== undefined && subtitle !== ''
  const hasAvatar = avatar !== undefined && avatar !== null

  useEffect(() => {
    const content = contentRef.current
    if (content === null) return
    const dialogElement = content.closest('[role="dialog"]')
    if (dialogElement === null) return
    const dialog = dialogElement as HTMLElement

    // Fokus awal: tanpa ini, pengguna keyboard tetap berada di luar dialog
    // setelah membukanya. Area isi memakai tabindex="-1" sehingga tak masuk
    // urutan Tab (hanya menerima fokus programmatic).
    content.focus()

    // Jebakan fokus: putar Tab di dalam dialog (tombol X di header + tombol
    // Tutup di footer). Tanpa ini, Tab melompat ke halaman di belakang modal.
    // Listener dipasang NATIVE pada elemen dialog — bukan `onKeyDown` React
    // pada area isi — karena tombol footer `Modal` berada di luar area isi,
    // sehingga event Tab darinya tak akan pernah sampai ke handler React.
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (first === undefined || last === undefined) return
      const current = focusables.indexOf(document.activeElement as HTMLElement)
      if (current === -1) {
        // Fokus belum berada pada elemen yang bisa difokus → masuk ke yang pertama.
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
        return
      }
      if (event.shiftKey && current === 0) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === focusables.length - 1) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', handleKeyDown)
    return () => dialog.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <Button variant="secondary" className="min-h-touch" onClick={onClose}>
          Tutup
        </Button>
      }
    >
      <div ref={contentRef} tabIndex={-1} className="outline-none">
        {hasAvatar ? (
          <div className="mb-3 flex items-center gap-3">
            <span className="flex shrink-0">{avatar}</span>
            {hasSubtitle ? (
              <p className="min-w-0 text-sm text-ink-secondary">{subtitle}</p>
            ) : null}
          </div>
        ) : hasSubtitle ? (
          <p className="mb-3 text-sm text-ink-secondary">{subtitle}</p>
        ) : null}
        <dl className="divide-y divide-border-light rounded-card border border-border-light bg-brand/5">
          {fields.map((field, index) => (
            <div
              key={`${field.label}-${index}`}
              className="flex flex-col gap-1 px-3 py-3 sm:flex-row sm:items-baseline sm:gap-4 sm:px-4"
            >
              <dt className="shrink-0 text-label font-semibold tracking-wide text-ink-muted sm:w-44">
                {field.label}
              </dt>
              <dd className="min-w-0 flex-1 break-words text-sm text-ink">
                {isEmptyDetailValue(field.value) ? (
                  <span className="text-ink-muted">{DETAIL_EMPTY_PLACEHOLDER}</span>
                ) : (
                  field.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  )
}
