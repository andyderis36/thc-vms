/**
 * SCR-03 — Otak murni untuk melaporkan & menyorot field wajib yang galat.
 *
 * Modul ini SENGAJA bebas DOM pada level atas modul (tidak menyentuh
 * `document`/`window` saat impor) agar bisa diuji di lingkungan `node`.
 * Satu-satunya fungsi yang menyentuh DOM, `revealInvalidField`, hanya
 * dipanggil dari sisi klien.
 *
 * `collectInvalidFields` menelusuri MANIFEST tetap dalam urutan visual/DOM,
 * BUKAN `Object.keys(errors)`, sehingga urutan keluaran stabil apa pun
 * urutan kunci objek galat dari react-hook-form.
 */

import type { FieldErrors } from 'react-hook-form'

import type { VisitFormValues } from './visit-schema'

/** Satu field wajib yang sedang galat, siap dipakai untuk toast & fokus DOM. */
export interface InvalidField {
  /** Jalur field (mis. `location_id`, `technicians.0.name`). */
  path: string
  /** Label manusiawi berbahasa Indonesia. */
  label: string
  /** `id` elemen DOM target untuk di-scroll & difokus. */
  anchorId: string
}

/** Field skalar bermanifest (semua selain blok `technicians`). */
interface ScalarFieldSpec {
  path: string
  label: string
  anchorId: string
}

/** Field manifest sebelum blok teknisi (urutan visual 1–5). */
const SCALAR_FIELDS_BEFORE_TECHNICIANS: readonly ScalarFieldSpec[] = [
  { path: 'location_id', label: 'Fasilitas Tujuan', anchorId: 'visit-location' },
  { path: 'purpose_ids', label: 'Tujuan Kunjungan', anchorId: 'visit-purpose' },
  { path: 'purpose_note', label: 'Tujuan lain', anchorId: 'visit-purpose-note' },
  { path: 'start_date', label: 'Waktu Mulai', anchorId: 'visit-start-date' },
  { path: 'end_date', label: 'Waktu Selesai', anchorId: 'visit-end-date' },
]

/** Field manifest setelah blok teknisi (urutan visual 7–9). */
const SCALAR_FIELDS_AFTER_TECHNICIANS: readonly ScalarFieldSpec[] = [
  {
    path: 'assignment_letter',
    label: 'Surat Tugas / SPK Vendor',
    anchorId: 'visit-assignment-letter',
  },
  { path: 'notes', label: 'Catatan Tambahan', anchorId: 'visit-notes' },
  {
    path: 'is_nda_accepted',
    label: 'Persetujuan SOP Keselamatan',
    anchorId: 'visit-nda',
  },
]

/**
 * Sub-kunci baris teknisi yang DAPAT galat — urutannya persis urutan DOM di
 * dalam satu kartu teknisi. `id_card_photo` dan `vendor_name` sengaja
 * dikecualikan: keduanya opsional dan tidak pernah wajib.
 */
interface TechnicianSubkeySpec {
  key: string
  label: (index: number) => string
}

const TECHNICIAN_SUBKEYS: readonly TechnicianSubkeySpec[] = [
  { key: 'name', label: (index) => `Nama lengkap teknisi (Teknisi ${index + 1})` },
  {
    key: 'id_number',
    label: (index) => `Nomor KTP/SIM teknisi (Teknisi ${index + 1})`,
  },
  { key: 'phone', label: (index) => `Nomor HP teknisi (Teknisi ${index + 1})` },
  { key: 'selfie', label: (index) => `Foto selfie teknisi (Teknisi ${index + 1})` },
]

/** `id` anchor elemen input pada baris teknisi (stabil & dapat diprediksi). */
export function technicianAnchorId(index: number, key: string): string {
  return `visit-tech-${index}-${key}`
}

/**
 * Membaca pesan galat dari nilai tak terduga. Mengembalikan `undefined` bila
 * nilai bukan objek, tidak punya `message`, atau pesannya string kosong
 * (string kosong dianggap "tidak galat").
 */
function readMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const { message } = value as { message?: unknown }
  return typeof message === 'string' && message !== '' ? message : undefined
}

/**
 * Mengumpulkan galat pada blok `technicians`:
 * - galat tingkat array (`{ message }`, BUKAN array) → satu entri `Daftar Teknisi`;
 * - galat per baris (array, mungkin sparse, `row` mungkin `undefined`) → per
 *   sub-kunci sesuai urutan DOM.
 */
function collectTechnicianFields(value: unknown): InvalidField[] {
  const fields: InvalidField[] = []

  if (value === null || value === undefined) return fields

  // Galat tingkat array: `.min`/`.max` menempel sebagai objek ber-`message`,
  // BUKAN array. Array per-baris tidak pernah punya `message` di sini.
  if (!Array.isArray(value)) {
    if (readMessage(value) !== undefined) {
      fields.push({
        path: 'technicians',
        label: 'Daftar Teknisi',
        anchorId: 'visit-technicians',
      })
    }
    return fields
  }

  value.forEach((row, index) => {
    if (row === null || typeof row !== 'object') return
    const rowError = row as Record<string, unknown>
    for (const subkey of TECHNICIAN_SUBKEYS) {
      if (readMessage(rowError[subkey.key]) === undefined) continue
      fields.push({
        path: `technicians.${index}.${subkey.key}`,
        label: subkey.label(index),
        anchorId: technicianAnchorId(index, subkey.key),
      })
    }
  })

  return fields
}

/** Menelusuri manifest tetap dan mengembalikan field galat dalam urutan DOM. */
export function collectInvalidFields(
  errors: FieldErrors<VisitFormValues>,
): InvalidField[] {
  const raw = errors as unknown as Record<string, unknown>
  const fields: InvalidField[] = []

  for (const spec of SCALAR_FIELDS_BEFORE_TECHNICIANS) {
    if (readMessage(raw[spec.path]) === undefined) continue
    fields.push({ path: spec.path, label: spec.label, anchorId: spec.anchorId })
  }

  fields.push(...collectTechnicianFields(raw['technicians']))

  for (const spec of SCALAR_FIELDS_AFTER_TECHNICIANS) {
    if (readMessage(raw[spec.path]) === undefined) continue
    fields.push({ path: spec.path, label: spec.label, anchorId: spec.anchorId })
  }

  return fields
}

/**
 * Menggabungkan label gaya daftar Indonesia: `A dan B`, atau `A, B, dan C`
 * (koma serial sebelum `dan` untuk tiga label atau lebih).
 */
function joinLabels(labels: readonly string[]): string {
  const first = labels[0]
  if (first === undefined) return ''
  if (labels.length === 1) return first
  const last = labels[labels.length - 1] ?? ''
  if (labels.length === 2) return `${first} dan ${last}`
  return `${labels.slice(0, -1).join(', ')}, dan ${last}`
}

/**
 * Menyusun pesan toast yang MENYEBUT nama field wajib yang galat.
 * `max` (default 3) membatasi jumlah label yang ditampilkan; sisanya
 * diringkas sebagai "N lainnya".
 */
export function formatInvalidMessage(
  fields: readonly InvalidField[],
  max = 3,
): string {
  if (fields.length === 0) {
    return 'Lengkapi field wajib sebelum mengirim permohonan.'
  }

  const labels = fields.map((field) => field.label)
  if (labels.length === 1) {
    return `Lengkapi ${labels[0] ?? ''} sebelum mengirim permohonan.`
  }

  const remaining = labels.length - max
  if (remaining > 0) {
    const shown = joinLabels(labels.slice(0, max))
    return `Lengkapi ${shown} dan ${remaining} lainnya sebelum mengirim permohonan.`
  }

  return `Lengkapi ${joinLabels(labels)} sebelum mengirim permohonan.`
}

/**
 * Menyorot field galat: scroll ke tengah, fokus tanpa scroll tambahan, lalu
 * pasang cincin `field-attention` selama 1600ms.
 *
 * `scrollIntoView`/`focus` dibungkus `try/catch` karena jsdom tidak
 * mengimplementasikannya. Modul ini TIDAK menyimpan state timer apa pun —
 * pemanggil yang mengulang reveal bertanggung jawab membersihkan timer
 * sebelumnya lewat ref.
 */
export function revealInvalidField(el: HTMLElement): void {
  const reduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  try {
    el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
  } catch {
    // jsdom tidak mengimplementasikan scrollIntoView — abaikan.
  }

  try {
    el.focus({ preventScroll: true })
  } catch {
    // Beberapa lingkungan tidak mengimplementasikan fokus programatik.
  }

  el.classList.add('field-attention')

  if (typeof window !== 'undefined') {
    window.setTimeout(() => {
      el.classList.remove('field-attention')
    }, 1600)
  }
}
