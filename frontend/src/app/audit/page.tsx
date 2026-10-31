'use client'

import { Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Inbox, Info, Server, Tag, UserRound } from 'lucide-react'
import { SuperadminShell } from '@/components/layouts/SuperadminShell'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { FilterResetButton } from '@/components/ui/FilterResetButton'
import { Input } from '@/components/ui/Input'
import { Pagination } from '@/components/ui/Pagination'
import { Select, type SelectOption } from '@/components/ui/Select'
import { SearchInput } from '@/components/ui/SearchInput'
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
import { TABLE_CARD_LIST_CLASS, TABLE_TD_CLASS, TABLE_TH_CLASS, TABLE_WRAPPER_CLASS, TABLE_CLASS } from '@/lib/table-styles'
import { type StatusTone } from '@/lib/visits/status-badge'
import { AuditDetailModal, type AuditActorInfo } from './AuditDetailModal'

// ---------------------------------------------------------------------------
// Helper murni (diekspor agar dapat diuji unit — lihat tests/audit-logs.test.ts)
// ---------------------------------------------------------------------------

/**
 * Batas baris per halaman — selaras default `limit` backend (openapi §571).
 * Batas server: 1..200; UI memakai kelipatan yang ramah tabel.
 */
export const AUDIT_PAGE_LIMIT = 50
export const AUDIT_MIN_LIMIT = 1
export const AUDIT_MAX_LIMIT = 200
export const AUDIT_LIMIT_OPTIONS: SelectOption[] = [
  { value: '20', label: '20 baris' },
  { value: '50', label: '50 baris' },
  { value: '100', label: '100 baris' },
  { value: '200', label: '200 baris' },
]

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
  'purpose.create': 'Buat tujuan',
  'purpose.update': 'Ubah tujuan',
  'purpose.delete': 'Hapus tujuan',
  'visit.delete': 'Hapus kunjungan',
}

/** Label entitas yang tersentuh aksi (kontrak `AuditLog.entity`). */
export const AUDIT_ENTITY_LABEL: Record<string, string> = {
  auth: 'Autentikasi',
  user: 'Pengguna',
  location: 'Fasilitas',
  purpose: 'Tujuan',
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

/**
 * Baris jejak yang boleh dirender: backend sudah membuang baris pelaku
 * `dev-superadmin` yang tersembunyi (beserta totalnya), dan lapisan ini
 * membuang baris yang pelakunya tak bisa dipecahkan lewat `GET /users` —
 * yang tak pernah memuat akun tersembunyi — agar cache basi pun tak bisa
 * merendernya. Baris sistem (`null`) selalu lolos. Diterapkan hanya setelah
 * daftar user termuat (`usersLoaded`); sebelumnya apa adanya.
 */
export function filterVisibleAuditItems(
  items: AuditLog[],
  usersById: ReadonlyMap<string, AuditActorInfo>,
  usersLoaded: boolean,
): AuditLog[] {
  if (!usersLoaded) return items
  return items.filter((log) => log.user_id === null || usersById.has(log.user_id))
}

/** Nama pelaku dari peta user; baris sistem (`null`) = "Sistem"; user terhapus = UUID pendek. */
export function auditActorLabel(
  userId: string | null,
  usersById: ReadonlyMap<string, AuditActorInfo>,
): string {
  if (userId === null) return 'Sistem'
  const name = usersById.get(userId)?.name
  if (name !== undefined && name !== '') return name
  return userId.slice(0, 8)
}

/**
 * Label pelaku yang jujur untuk tampilan baris: aksi autentikasi tanpa sesi
 * (`auth.*` + `null`, mis. login gagal) = "Upaya masuk (tanpa sesi)", bukan
 * "Sistem"; `null` non-autentikasi = "Sistem"; pelaku yang tak ada di peta
 * user (akun terhapus, cache basi) = "Akun terhapus", bukan potongan UUID
 * yang menyesatkan. Murni; tanpa jaringan/state.
 */
export function auditActorLabelHonest(
  log: Pick<AuditLog, 'user_id' | 'action'>,
  usersById: ReadonlyMap<string, AuditActorInfo>,
): string {
  if (log.user_id === null) {
    return log.action.startsWith('auth.') ? 'Upaya masuk (tanpa sesi)' : 'Sistem'
  }
  const name = usersById.get(log.user_id)?.name
  if (name !== undefined && name !== '') return name
  return 'Akun terhapus'
}

/** Ringkas metadata kunci→nilai untuk satu baris; kosong/null = strip. */
export function auditMetadataSummary(metadata: Record<string, string> | null | undefined): string {
  const entries = Object.entries(metadata ?? {})
  if (entries.length === 0) return '—'
  return entries.map(([key, value]) => `${key}: ${value}`).join(' · ')
}

export const AUDIT_METADATA_KEY_LABEL: Record<string, string> = {
  email: 'Surel',
  reason: 'Alasan',
  role: 'Peran',
  source: 'Sumber',
  from: 'Dari',
  to: 'Ke',
  fields: 'Kolom diubah',
  name: 'Nama',
  visit_code: 'Kode kunjungan',
  type: 'Jenis',
  phone: 'Telepon',
  status: 'Status',
  location: 'Fasilitas',
  location_id: 'Fasilitas',
  facility: 'Fasilitas',
  address: 'Alamat',
  old_name: 'Nama lama',
  new_name: 'Nama baru',
  city: 'Kota',
  timezone: 'Zona waktu',
  is_active: 'Status',
  nik: 'NIK',
  vendor_id: 'ID vendor',
  vendor_name: 'Nama vendor',
  password: 'Kata sandi',
  avatar_url: 'Foto profil',
  old_phone: 'Telepon lama',
  new_phone: 'Telepon baru',
  old_avatar: 'Foto lama',
  new_avatar: 'Foto baru',
}

export const AUDIT_METADATA_VALUE_LABEL: Record<string, string> = {
  invalid_credentials: 'kredensial salah',
  active: 'Aktif',
  inactive: 'Nonaktif',
  vendor: 'Vendor',
  admin: 'Admin',
  super_admin: 'Superadmin',
  security: 'Petugas jaga',
  'self-registration': 'Pendaftaran mandiri',
  name: 'Nama',
  email: 'Surel',
  phone: 'Telepon',
  nik: 'NIK',
  location_id: 'Fasilitas',
  vendor_id: 'ID vendor',
  vendor_name: 'Nama vendor',
  password: 'Kata sandi',
  avatar_url: 'Foto profil',
  is_active: 'Status',
  type: 'Jenis',
  address: 'Alamat',
  city: 'Kota',
  timezone: 'Zona waktu',
  status: 'Status',
  role: 'Peran',
  source: 'Sumber',
  old_name: 'Nama lama',
  new_name: 'Nama baru',
  old_phone: 'Telepon lama',
  new_phone: 'Telepon baru',
}

export function auditMetadataKeyLabel(key: string): string {
  return AUDIT_METADATA_KEY_LABEL[key] ?? key
}

export function auditMetadataKeyTranslated(key: string): string {
  return auditMetadataKeyLabel(key)
}

export function auditMetadataValueLabel(value: string): string {
  return AUDIT_METADATA_VALUE_LABEL[value] ?? value
}

export function auditMetadataValueTranslated(value: string): string
export function auditMetadataValueTranslated(key: string, value: string): string
export function auditMetadataValueTranslated(a: string, b?: string): string {
  if (b === undefined) {
    return AUDIT_METADATA_VALUE_LABEL[a] ?? a
  }
  if (a === 'fields') {
    return String(b)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => AUDIT_METADATA_VALUE_LABEL[part] ?? part)
      .join(', ')
  }
  return AUDIT_METADATA_VALUE_LABEL[b] ?? b
}

export interface AuditMetadataEntryTranslated {
  key: string
  value: string
}

export function auditMetadataEntriesTranslated(
  metadata: Record<string, string> | null | undefined,
): AuditMetadataEntryTranslated[] {
  const entries = Object.entries(metadata ?? {})
  return entries.map(([key, value]) => {
    const translatedKey = auditMetadataKeyLabel(key)
    const translatedValue =
      key === 'fields'
        ? String(value)
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '')
            .map((part) => AUDIT_METADATA_VALUE_LABEL[part] ?? part)
            .join(', ')
        : auditMetadataValueLabel(String(value))
    return { key: translatedKey, value: translatedValue }
  })
}

export function auditMetadataSummaryTranslated(
  metadata: Record<string, string> | null | undefined,
): string {
  const entries = auditMetadataEntriesTranslated(metadata)
  if (entries.length === 0) return '—'
  return entries.map((entry) => `${entry.key}: ${entry.value}`).join(' · ')
}

/** Satu kolom yang berubah, dikelompokkan dari kunci `before.<kolom>`/`after.<kolom>`. */
export interface AuditBeforeAfterPair {
  /** Nama kolom mentah di balik kunci, mis. `is_active`. */
  field: string
  /** Label kolom Bahasa Indonesia; kunci tak dikenal = mentah. */
  label: string
  /** Nilai sebelum; `null` = sisi tak ada/kosong → render "—". */
  before: string | null
  /** Nilai sesudah; `null` = sisi tak ada/kosong → render "—". */
  after: string | null
}

/**
 * Label kolom untuk pasangan before/after: kamus nilai memuat nama kolom
 * (`name` → "Nama", `is_active` → "Status"); kunci tak dikenal jatuh mentah
 * (jangan mengarang label — hanya render yang ditulis backend).
 */
export function auditBeforeAfterFieldLabel(field: string): string {
  return AUDIT_METADATA_VALUE_LABEL[field] ?? AUDIT_METADATA_KEY_LABEL[field] ?? field
}

/** Sisi pasangan yang hilang/kosong (backend mengirim string kosong untuk NULL). */
function auditPairSide(
  entries: Record<string, string>,
  key: string,
): string | null {
  if (!(key in entries)) return null
  const raw: unknown = entries[key]
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  return text !== '' ? text : null
}

/**
 * Mengelompokkan kunci aditif `before.<kolom>`/`after.<kolom>` per kolom.
 * Urutan deterministik: ikuti CSV `fields` bila ada (urutan penulis backend),
 * lalu kolom lain sesuai kemunculan pertama. Kolom dari `fields` yang tak
 * punya pasangan dilewati — ia tetap dirender baris "Kolom diubah" warisan.
 */
export function groupBeforeAfter(
  metadata: Record<string, string> | null | undefined,
): AuditBeforeAfterPair[] {
  const entries = metadata ?? {}
  const order: string[] = []
  const seen = new Set<string>()
  const pushField = (field: string): void => {
    if (field !== '' && !seen.has(field)) {
      seen.add(field)
      order.push(field)
    }
  }
  const rawFields: unknown = entries['fields']
  if (typeof rawFields === 'string') {
    for (const part of rawFields.split(',')) pushField(part.trim())
  }
  for (const key of Object.keys(entries)) {
    if (key.startsWith('before.')) pushField(key.slice('before.'.length))
    else if (key.startsWith('after.')) pushField(key.slice('after.'.length))
  }
  const pairs: AuditBeforeAfterPair[] = []
  for (const field of order) {
    const beforeKey = `before.${field}`
    const afterKey = `after.${field}`
    if (!(beforeKey in entries) && !(afterKey in entries)) continue
    pairs.push({
      field,
      label: auditBeforeAfterFieldLabel(field),
      before: auditPairSide(entries, beforeKey),
      after: auditPairSide(entries, afterKey),
    })
  }
  return pairs
}

/** Pasangan status gaya `from`/`to` (penulis `user.status`), nilai terjemahan. */
export interface AuditStatusPair {
  /** Nilai `from` terjemahan; sisi hilang = "—". */
  from: string
  /** Nilai `to` terjemahan; sisi hilang = "—". */
  to: string
}

/**
 * Pasangan status `from`/`to`; `null` bila kedua kunci tak ada — pemanggil
 * jatuh kembali ke ringkasan lama. Sisi yang hilang dirender "—".
 */
export function auditStatusPair(
  metadata: Record<string, string> | null | undefined,
): AuditStatusPair | null {
  const entries = metadata ?? {}
  if (!('from' in entries) && !('to' in entries)) return null
  const readSide = (key: string): string => {
    const side = auditPairSide(entries, key)
    return side !== null ? auditMetadataValueLabel(side) : '—'
  }
  return { from: readSide('from'), to: readSide('to') }
}

/** Nilai pasangan untuk tampil: terjemahan kamus, sisi hilang = "—". */
function auditPairDisplayValue(side: string | null): string {
  return side !== null ? auditMetadataValueLabel(side) : '—'
}

/**
 * Ringkasan satu baris sadar-pasangan untuk tooltip tabel/kartu. Tanpa kunci
 * baru (`from`/`to`/`before.*`/`after.*`) mengembalikan PERSIS keluaran
 * `auditMetadataSummaryTranslated` — baris warisan tak berubah sedikit pun.
 */
export function auditMetadataPairSummary(
  metadata: Record<string, string> | null | undefined,
): string {
  const entries = metadata ?? {}
  const status = auditStatusPair(entries)
  const pairs = groupBeforeAfter(entries)
  if (status === null && pairs.length === 0) {
    return auditMetadataSummaryTranslated(entries)
  }
  const parts: string[] = []
  if (status !== null) {
    parts.push(`Dari ${status.from} Ke ${status.to}`)
  }
  const pairedFields = new Set(pairs.map((pair) => pair.field))
  for (const pair of pairs) {
    const before = auditPairDisplayValue(pair.before)
    const after = auditPairDisplayValue(pair.after)
    parts.push(`Kolom ${pair.label}: ${before} → ${after}`)
  }
  // `fields` yang tak tercakup pasangan (mis. kata sandi — penulis sengaja
  // tak pernah mengirim nilainya) tetap dilaporkan agar tak ada info hilang.
  const rawFields: unknown = entries['fields']
  if (typeof rawFields === 'string') {
    const uncovered = rawFields
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '' && !pairedFields.has(part))
    if (uncovered.length > 0) {
      const value = uncovered.map((field) => auditMetadataValueLabel(field)).join(', ')
      parts.push(`Kolom diubah: ${value}`)
    }
  }
  // Sisa kunci lain: terjemahan Phase-1 apa adanya, tanpa kunci terkonsumsi.
  const consumed = new Set<string>(['from', 'to', 'fields'])
  for (const pair of pairs) {
    consumed.add(`before.${pair.field}`)
    consumed.add(`after.${pair.field}`)
  }
  for (const [key, value] of Object.entries(entries)) {
    if (consumed.has(key)) continue
    const raw: unknown = value
    const text = typeof raw === 'string' ? raw : String(raw ?? '')
    const translated =
      key === 'fields'
        ? auditMetadataValueTranslated('fields', text)
        : auditMetadataValueLabel(text)
    parts.push(`${auditMetadataKeyLabel(key)}: ${translated}`)
  }
  return parts.length > 0 ? parts.join(' · ') : '—'
}

/** Satu baris Metadata modal: label, nilai tampil, tooltip, dan mode potong. */
export interface AuditMetadataDisplayRow {
  /** Kunci React stabil (kunci mentah / `from/to` / `fields`). */
  key: string
  label: string
  value: string
  /** Teks utuh untuk tooltip `title` (hanya dipakai baris pasangan). */
  title: string
  /** `true` = baris pasangan → nilai `truncate` + tooltip; warisan = `false`. */
  truncate: boolean
}

/**
 * Baris Metadata modal sadar-pasangan. Tanpa kunci baru hasilnya setara
 * `auditMetadataEntriesTranslated` (label/nilai terjemahan, `truncate: false`)
 * — baris warisan mempertahankan struktur dan gaya Phase-1.
 */
export function auditMetadataDisplayRows(
  metadata: Record<string, string> | null | undefined,
): AuditMetadataDisplayRow[] {
  const entries = metadata ?? {}
  const rows: AuditMetadataDisplayRow[] = []
  const status = auditStatusPair(entries)
  if (status !== null) {
    const value = `Dari ${status.from} Ke ${status.to}`
    rows.push({ key: 'from/to', label: 'Perubahan status', value, title: value, truncate: true })
  }
  const pairs = groupBeforeAfter(entries)
  const pairedFields = new Set(pairs.map((pair) => pair.field))
  for (const pair of pairs) {
    const before = auditPairDisplayValue(pair.before)
    const after = auditPairDisplayValue(pair.after)
    const label = `Kolom ${pair.label}`
    const value = `${before} → ${after}`
    rows.push({
      key: `before.${pair.field}`,
      label,
      value,
      title: `${label}: ${value}`,
      truncate: true,
    })
  }
  const rawFields: unknown = entries['fields']
  if (typeof rawFields === 'string') {
    const uncovered = rawFields
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '' && !pairedFields.has(part))
    if (uncovered.length > 0) {
      const value = uncovered.map((field) => auditMetadataValueLabel(field)).join(', ')
      rows.push({
        key: 'fields',
        label: 'Kolom diubah',
        value,
        title: `Kolom diubah: ${value}`,
        truncate: false,
      })
    }
  }
  const consumed = new Set<string>(['from', 'to', 'fields'])
  for (const pair of pairs) {
    consumed.add(`before.${pair.field}`)
    consumed.add(`after.${pair.field}`)
  }
  for (const [key, value] of Object.entries(entries)) {
    if (consumed.has(key)) continue
    const translated = auditMetadataEntriesTranslated({ [key]: value })
    const entry = translated[0]
    if (entry === undefined) continue
    rows.push({
      key,
      label: entry.key,
      value: entry.value,
      title: `${entry.key}: ${entry.value}`,
      truncate: false,
    })
  }
  return rows
}

/**
 * Subjek yang tersentuh aksi: utamakan nama/email yang dibawa metadata,
 * baru `entity_id` (UUID/penanda) sebagai fallback terakhir. Tidak pernah
 * mencetak "Sistem" — pelaku sudah diwakili `actorLabel`.
 */
function auditImpactSubject(
  log: AuditLog,
  metadata: Record<string, string>,
): string {
  if (metadata.name !== undefined && metadata.name !== '') return metadata.name
  if (metadata.email !== undefined && metadata.email !== '') return metadata.email
  if (log.entity_id !== null && log.entity_id !== '') return log.entity_id
  return '—'
}

/**
 * Kalimat dampak Bahasa Indonesia per aksi audit (13 aksi MVP). Murni: tidak
 * menyentuh jaringan/state; `actorLabel` disuntik pemanggil (null-auth →
 * "Upaya masuk (tanpa sesi)", akun terhapus → "Akun terhapus"). Label kunci
 * dan nilai diambil dari kamus yang sama (tanpa literal duplikat).
 */
export function auditImpactSentence(log: AuditLog, actorLabel: string): string {
  const A = actorLabel
  const metadata = (log.metadata ?? {}) as Record<string, string>

  if (log.action === 'user.create') {
    const B = auditImpactSubject(log, metadata)
    const R = metadata.role ? auditMetadataValueLabel(metadata.role) : '—'
    return `${A} membuat akun ${B} sebagai Peran ${R}`
  }
  if (log.action === 'location.create') {
    const B = auditImpactSubject(log, metadata)
    return `${A} membuat fasilitas bernama ${B}`
  }
  if (log.action === 'purpose.create') {
    const B = auditImpactSubject(log, metadata)
    return `${A} membuat tujuan kunjungan bernama ${B}`
  }
  if (log.action === 'user.status') {
    const B = auditImpactSubject(log, metadata)
    const X = metadata.from ? auditMetadataValueLabel(metadata.from) : '—'
    const Y = metadata.to ? auditMetadataValueLabel(metadata.to) : '—'
    return `${A} mengubah status ${B} dari ${X} menjadi ${Y}`
  }
  if (log.action === 'visit.delete') {
    const V = metadata.visit_code && metadata.visit_code !== '' ? metadata.visit_code : '—'
    return `${A} menghapus kunjungan Kode ${V}`
  }
  if (log.action === 'auth.login.failed') {
    const E = metadata.email && metadata.email !== '' ? metadata.email : '—'
    const reason = metadata.reason ? auditMetadataValueLabel(metadata.reason) : 'kredensial salah'
    return `Upaya masuk gagal untuk surel ${E} (${reason})`
  }
  if (log.action === 'auth.login.success') {
    const E = metadata.email && metadata.email !== '' ? metadata.email : '—'
    return `${A} masuk berhasil (surel ${E})`
  }
  if (
    log.action === 'user.update' ||
    log.action === 'location.update' ||
    log.action === 'purpose.update'
  ) {
    const noun =
      log.action === 'user.update'
        ? 'akun'
        : log.action === 'location.update'
          ? 'fasilitas'
          : 'tujuan kunjungan'
    const B = auditImpactSubject(log, metadata)
    const columns = metadata.fields
      ? auditMetadataValueTranslated('fields', metadata.fields)
      : '—'
    let sentence = `${A} mengubah ${noun} ${B}: ${columns}`

    const hasFromTo = 'from' in metadata || 'to' in metadata
    const hasBeforeAfter =
      Object.keys(metadata).some((key) => key.startsWith('before.')) ||
      Object.keys(metadata).some((key) => key.startsWith('after.'))
    if (hasFromTo || hasBeforeAfter) {
      let X = '—'
      let Y = '—'
      if (hasFromTo) {
        X = metadata.from ? auditMetadataValueLabel(metadata.from) : '—'
        Y = metadata.to ? auditMetadataValueLabel(metadata.to) : '—'
      } else {
        const fieldsOrder = metadata.fields
          ? metadata.fields
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part !== '')
          : []
        const beforeAfterFields = Object.keys(metadata)
          .filter((key) => key.startsWith('before.') || key.startsWith('after.'))
          .map((key) => key.replace(/^(before|after)\./, ''))
          .filter((value, index, array) => array.indexOf(value) === index)
        const candidates = fieldsOrder.length > 0 ? fieldsOrder : beforeAfterFields
        const field = candidates.find(
          (candidate) =>
            `before.${candidate}` in metadata || `after.${candidate}` in metadata,
        )
        if (field) {
          const beforeValue = metadata[`before.${field}`]
          const afterValue = metadata[`after.${field}`]
          X = beforeValue ? auditMetadataValueLabel(beforeValue) : '—'
          Y = afterValue ? auditMetadataValueLabel(afterValue) : '—'
        }
      }
      sentence += ` (Dari ${X}→${Y})`
    }
    return sentence
  }
  if (log.action === 'user.delete') {
    const B = auditImpactSubject(log, metadata)
    return `${A} menghapus akun ${B}`
  }
  if (log.action === 'location.delete') {
    const B = auditImpactSubject(log, metadata)
    return `${A} menghapus fasilitas ${B}`
  }
  if (log.action === 'purpose.delete') {
    const B = auditImpactSubject(log, metadata)
    return `${A} menghapus tujuan kunjungan ${B}`
  }

  const label = auditActionLabel(log.action)
  const summary = auditMetadataSummaryTranslated(metadata)
  return `${label} — ${summary}`
}

export type AuditOrder = 'asc' | 'desc'

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
  /** Pencarian bebas (`q`); `''` = tanpa pencarian. */
  q?: string
  /** Arah urutan waktu; default `desc` (server). */
  order?: AuditOrder
  /** Baris per halaman; default `AUDIT_PAGE_LIMIT`. */
  limit?: number
}

export const EMPTY_AUDIT_FILTER: AuditFilter = {
  userId: 'all',
  entity: '',
  action: '',
  dateFrom: '',
  dateTo: '',
  q: '',
  order: 'desc',
  limit: AUDIT_PAGE_LIMIT,
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `user_id` harus UUID berbentuk 8-4-4-4-12 hex. Backend membalas 400 untuk
 * nilai lain, sedangkan nilai asing di Select hanya menghasilkan kontrol kosong
 * — jadi filter tak valid dibuang lebih awal, bukan dikirim.
 */
export function isValidAuditUserId(value: string): boolean {
  return UUID_SHAPE.test(value.trim())
}

/**
 * Tanggal harus `YYYY-MM-DD` **dan** tanggal kalender nyata. Regex saja tidak
 * cukup: `2026-02-30` lolos bentuk tetapi bergulir ke 2 Maret di `Date`,
 * sehingga round-trip komponen (tahun/bulan/hari) dipakai sebagai pembeda.
 */
export function isValidAuditDate(value: string): boolean {
  const trimmed = value.trim()
  if (!ISO_DATE_ONLY.test(trimmed)) return false
  const [year = '0', month = '1', day = '1'] = trimmed.split('-')
  const parsed = new Date(Number(year), Number(month) - 1, Number(day))
  return (
    parsed.getFullYear() === Number(year) &&
    parsed.getMonth() === Number(month) - 1 &&
    parsed.getDate() === Number(day)
  )
}

/**
 * Opsi Select yang hanya merender daftar tertutup akan tampak kosong bila
 * `value` berasal dari URL (`?limit=37`, pelaku yang sudah dihapus). Helper ini
 * menambahkan tepat satu opsi fallback berlabel nilai tersebut agar kontrol
 * tetap menampilkan pilihan aktifnya; nilai kosong/`'all'`/yang sudah ada tidak
 * diubah sama sekali.
 */
export function withFallbackOption(
  options: SelectOption[],
  value: string,
  label: string,
): SelectOption[] {
  if (value === '' || value === 'all') return options
  if (options.some((option) => option.value === value)) return options
  return [...options, { value, label }]
}

/**
 * Filter dianggap aktif bila salah satu dimensi URL menyimpang dari default —
 * termasuk kata kunci yang sedang diketik (belum tentu sudah ter-debounce ke
 * `filter.q`). Dipakai tombol reset dan teks empty state.
 */
export function auditHasActiveFilter(filter: AuditFilter, searchInput: string): boolean {
  return (
    filter.userId !== 'all' ||
    filter.entity !== '' ||
    filter.action !== '' ||
    filter.dateFrom !== '' ||
    filter.dateTo !== '' ||
    (filter.order ?? 'desc') !== 'desc' ||
    (filter.limit ?? AUDIT_PAGE_LIMIT) !== AUDIT_PAGE_LIMIT ||
    (filter.q ?? '').trim() !== '' ||
    searchInput.trim() !== ''
  )
}

/**
 * Backend menafsirkan `YYYY-MM-DD` sebagai tengah malam **UTC** dan `date_to`
 * bersifat eksklusif (`timestamp < date_to`). Untuk pengguna WIB itu menggeser
 * batas ±7 jam sehingga baris 00:00–06:59 lokal hari ini hilang dan baris dini
 * hari berikutnya ikut terbawa. Karena itu batas tanggal diperluas ke hari
 * LOKAL dalam bentuk RFC3339: `date_from` = 00:00 lokal hari itu, `date_to` =
 * 00:00 lokal hari berikutnya (eksklusif). URL & input tetap `YYYY-MM-DD`.
 */
export function expandAuditDateBound(value: string, upper: boolean): string {
  if (!ISO_DATE_ONLY.test(value)) return value
  const [year = '0', month = '1', day = '1'] = value.split('-')
  const bound = new Date(Number(year), Number(month) - 1, Number(day) + (upper ? 1 : 0), 0, 0, 0, 0)
  return bound.toISOString()
}

/**
 * Normalisasi filter UI menjadi query `GET /audit-logs` — string kosong,
 * whitespace, dan sentinel `'all'` dibuang agar tidak terkirim (kontrak §571).
 */
export function toAuditLogListParams(
  filter: AuditFilter,
  page: number,
): AuditLogListParams {
  const params: AuditLogListParams = {
    page,
    limit: filter.limit ?? AUDIT_PAGE_LIMIT,
    order: filter.order ?? 'desc',
  }
  // Pertahanan berlapis: filter bisa datang dari URL/state lama, jadi ulangi
  // validasi yang sama sebelum menyentuh server (400 untuk UUID/tanggal rusak,
  // hasil kosong tanpa pesan untuk entitas/aksi di luar himpunan tertutup).
  const userId = filter.userId.trim()
  if (userId !== '' && userId !== 'all' && isValidAuditUserId(userId)) {
    params.user_id = userId
  }
  const entity = filter.entity.trim()
  if (entity !== '' && AUDIT_ENTITY_LABEL[entity] !== undefined) params.entity = entity
  const action = filter.action.trim()
  if (action !== '' && AUDIT_ACTION_LABEL[action] !== undefined) params.action = action
  const dateFrom = filter.dateFrom.trim()
  if (isValidAuditDate(dateFrom)) params.date_from = expandAuditDateBound(dateFrom, false)
  const dateTo = filter.dateTo.trim()
  if (isValidAuditDate(dateTo)) params.date_to = expandAuditDateBound(dateTo, true)
  const q = (filter.q ?? '').trim()
  if (q !== '') params.q = q
  return params
}

export interface AuditUrlState {
  filter: AuditFilter
  page: number
}

/** Clamp `limit` ke jendela server (1..200); nilai tak valid → default halaman. */
export function normaliseAuditLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return AUDIT_PAGE_LIMIT
  return Math.min(AUDIT_MAX_LIMIT, Math.max(AUDIT_MIN_LIMIT, parsed))
}

/**
 * Sumber kebenaran filter ada di URL (`?user_id=&entity=&action=&from=&to=&q=
 * &order=&limit=&page=`) agar refresh, back/forward, dan tautan yang dibagikan
 * memulihkan tampilan yang sama. Kunci kosong/default sengaja tidak ditulis
 * supaya URL bersih tetap ringkas.
 */
export function auditUrlStateFromParams(params: {
  get: (key: string) => string | null
}): AuditUrlState {
  const rawUserId = (params.get('user_id') ?? '').trim()
  // UUID tak valid dipetakan ke sentinel `'all'`, bukan `''`: nilai kosong bukan
  // sentinel, sehingga `auditHasActiveFilter` akan melaporkan filter aktif palsu
  // dan empty state berkata "tidak cocok" padahal tak ada yang disaring.
  const userId = isValidAuditUserId(rawUserId) ? rawUserId : 'all'

  const rawEntity = (params.get('entity') ?? '').trim()
  const entity = AUDIT_ENTITY_LABEL[rawEntity] !== undefined ? rawEntity : ''

  const rawAction = (params.get('action') ?? '').trim()
  const action = AUDIT_ACTION_LABEL[rawAction] !== undefined ? rawAction : ''

  const rawFrom = (params.get('from') ?? '').trim()
  const rawTo = (params.get('to') ?? '').trim()
  // Rentang terbalik (`from` > `to`) sengaja TIDAK ditukar: menukarnya saat parse
  // membuat round-trip URL tidak idempoten — filter di memori masih terbalik
  // (kartu "Rentang tanggal tidak valid" tampil) tetapi reload membaca state lain
  // dan hasil berubah diam-diam. Guard kartu adalah pemilik keadaan ini.
  const dateFrom = isValidAuditDate(rawFrom) ? rawFrom : ''
  const dateTo = isValidAuditDate(rawTo) ? rawTo : ''

  return {
    filter: {
      userId,
      entity,
      action,
      dateFrom,
      dateTo,
      q: (params.get('q') ?? '').trim(),
      order: params.get('order') === 'asc' ? 'asc' : 'desc',
      limit: normaliseAuditLimit(params.get('limit')),
    },
    page: Math.max(1, Number.parseInt(params.get('page') ?? '', 10) || 1),
  }
}

export function auditSearchParams(filter: AuditFilter, page: number): URLSearchParams {
  const params = new URLSearchParams()
  const userId = filter.userId.trim()
  if (userId !== '' && userId !== 'all') params.set('user_id', userId)
  const optional: Array<[string, string]> = [
    ['entity', filter.entity],
    ['action', filter.action],
    ['from', filter.dateFrom],
    ['to', filter.dateTo],
    ['q', filter.q ?? ''],
  ]
  for (const [key, raw] of optional) {
    const value = raw.trim()
    if (value !== '') params.set(key, value)
  }
  if ((filter.order ?? 'desc') === 'asc') params.set('order', 'asc')
  const limit = filter.limit ?? AUDIT_PAGE_LIMIT
  if (limit !== AUDIT_PAGE_LIMIT) params.set('limit', String(limit))
  if (page > 1) params.set('page', String(page))
  return params
}

function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Rentang tanggal lokal inklusif: `days=1` = hari ini, `days=7` = 7 hari terakhir. */
export function auditPresetRange(
  days: number,
  now: Date = new Date(),
): { dateFrom: string; dateTo: string } {
  const dateTo = toIsoDate(now)
  if (days <= 1) return { dateFrom: dateTo, dateTo }
  const start = new Date(now)
  start.setDate(start.getDate() - (days - 1))
  return { dateFrom: toIsoDate(start), dateTo }
}

const ENTITY_OPTIONS: SelectOption[] = [
  { value: '', label: 'Semua Entitas' },
  ...Object.entries(AUDIT_ENTITY_LABEL).map(([value, label]) => ({ value, label })),
]

const ACTION_OPTIONS: SelectOption[] = [
  { value: '', label: 'Semua Aksi' },
  ...Object.entries(AUDIT_ACTION_LABEL).map(([value, label]) => ({ value, label })),
]

const ORDER_OPTIONS: SelectOption[] = [
  { value: 'desc', label: 'Terbaru dulu' },
  { value: 'asc', label: 'Terlama dulu' },
]

/**
 * Jejak audit lintas cabang (super_admin) — kontrak `GET /audit-logs`.
 * Guard penuh `RequireRole allow=['super_admin']` + `SuperadminShell`.
 */
export default function AuditPage() {
  return (
    <RequireRole allow={['super_admin']}>
      {/* Suspense wajib: AuditScreen membaca `useSearchParams` untuk memulihkan
          filter dari URL, dan Next menolak prerender tanpa batas Suspense. */}
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            <Spinner size="lg" label="Memuat jejak audit." />
          </div>
        }
      >
        <AuditScreen />
      </Suspense>
    </RequireRole>
  )
}

function AuditScreen() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const currentQuery = searchParams.toString()
  const [initial] = useState<AuditUrlState>(() => auditUrlStateFromParams(searchParams))
  const [filter, setFilter] = useState<AuditFilter>(initial.filter)
  const [page, setPage] = useState(initial.page)
  const [searchInput, setSearchInput] = useState(initial.filter.q ?? '')
  // Record terpilih untuk modal detail; null = tertutup. Record lengkap sudah
  // ada di `items`, jadi pemilihan murni state UI tanpa fetch baris tambahan.
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null)
  // Query URL terakhir yang ditulis/dibaca — hanya untuk mencegah `replace`
  // berulang dan membedakan navigasi eksternal dari tulisan kita sendiri.
  const lastWritten = useRef(currentQuery)

  useEffect(() => {
    const built = auditSearchParams(filter, page).toString()
    if (built === lastWritten.current) return
    lastWritten.current = built
    router.replace(built === '' ? pathname : `${pathname}?${built}`, { scroll: false })
  }, [filter, page, pathname, router])

  // Navigasi same-route (mis. klik menu `/audit` saat sudah di `/audit?q=admin`)
  // mengganti URL tanpa mengubah state lokal. Efek ini HANYA bergantung pada
  // string query: kalau ia juga bergantung pada `filter`/`page`, render lokal
  // (URL belum ter-commit) akan membaca query lama dan menghapus order/tanggal
  // yang baru diubah. Back/forward juga lewat jalur ini.
  useEffect(() => {
    if (currentQuery === lastWritten.current) return
    lastWritten.current = currentQuery
    const next = auditUrlStateFromParams(new URLSearchParams(currentQuery))
    setFilter(next.filter)
    setPage(next.page)
    setSearchInput(next.filter.q ?? '')
  }, [currentQuery])

  // Debounce 300ms: satu request per jeda ketik, bukan per karakter.
  useEffect(() => {
    const next = searchInput.trim()
    if (next === (filter.q ?? '')) return
    const timer = setTimeout(() => {
      setFilter((prev) => ({ ...prev, q: next }))
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput, filter.q])

  // Rentang terbalik (`from` > `to`) adalah keadaan yang mustahil dipenuhi
  // server: `date_from` yang lebih akhir dari `date_to` selalu kosong. Alih-alih
  // mengirim request sia-sia, query dimatikan dan kartu perbaikan ditampilkan.
  const rangeInverted =
    filter.dateFrom !== '' && filter.dateTo !== '' && filter.dateFrom > filter.dateTo

  const params = useMemo(() => toAuditLogListParams(filter, page), [filter, page])
  const auditQuery = useAuditLogsQuery(params, !rangeInverted)
  const usersQuery = useManagedUsersQuery({})
  const { pendingCount } = usePendingApprovalCount()

  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data])
  const usersById = useMemo(
    () =>
      new Map<string, AuditActorInfo>(
        users.map((user) => [user.id, { name: user.name, email: user.email }]),
      ),
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
    setSearchInput('')
    setPage(1)
  }

  // Toggle: memilih baris yang sama lagi menutup modal. Overlay menutupi
  // tabel saat modal terbuka, jadi jalur toggle praktis hanya lewat keyboard
  // — tetap dibuat konsisten agar klik dan Enter/Space berperilaku sama.
  const handleSelectLog = (log: AuditLog): void => {
    setSelectedLog((prev) => (prev?.id === log.id ? null : log))
  }

  // Baris tersembunyi (pelaku `dev-superadmin` / tak terpecahkan) tak pernah
  // dirender: backend membuangnya, lapisan ini membuang sisanya (cache basi).
  const items = useMemo(
    () =>
      filterVisibleAuditItems(
        auditQuery.data?.items ?? [],
        usersById,
        usersQuery.isSuccess,
      ),
    [auditQuery.data, usersById, usersQuery.isSuccess],
  )
  const total = auditQuery.data?.total ?? 0
  const pageLimit = filter.limit ?? AUDIT_PAGE_LIMIT
  const totalPages = Math.max(1, Math.ceil(total / pageLimit))

  // `?page=999` (tautan lama, atau baris menyusut antar-request) tidak boleh
  // menampilkan "Belum ada jejak audit" padahal `total > 0`. Dijepit saat
  // render — bukan lewat effect — supaya tidak ada setState berantai.
  // `isPlaceholderData` menandai render jendela transisi (data halaman lama
  // masih dipakai selama fetch halaman baru) — itu bukan halaman kosong.
  const pageOutOfRange = !auditQuery.isPlaceholderData && total > 0 && items.length === 0
  const safePage = Math.min(page, totalPages)

  const presetToday = auditPresetRange(1)
  const presetWeek = auditPresetRange(7)
  const presetMonth = auditPresetRange(30)
  // Satu sumber kebenaran "ada filter aktif" — helper yang sama dipakai tombol
  // reset (top, error, empty) agar status nonaktif tidak pernah berbeda antar
  // tombol. Kata kunci yang sedang diketik ikut dihitung.
  const hasActiveFilter = auditHasActiveFilter(filter, searchInput)
  const emptyTitle = hasActiveFilter
    ? 'Tidak ada jejak audit yang cocok'
    : 'Belum ada jejak audit'
  const emptyDescription = hasActiveFilter
    ? 'Coba ubah kata kunci, pelaku, entitas, aksi, atau rentang tanggal.'
    : 'Setiap aksi administratif akan tercatat otomatis di sini.'

  return (
    <SuperadminShell pendingCount={pendingCount} activeHref="/audit">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-ink">Jejak Audit</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Lacak aktivitas sistem lintas cabang: siapa, apa, dan kapan.
        </p>
      </div>

      <div className="card flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <SearchInput
              type="search"
              aria-label="Cari jejak audit"
              placeholder="Cari aksi, entitas, pelaku, email, atau IP…"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <div className="min-w-40 flex-1 sm:w-44 sm:flex-none">
            <Select
              label="Urutan"
              options={ORDER_OPTIONS}
              value={filter.order ?? 'desc'}
              onChange={(event) =>
                updateFilter({ order: event.target.value === 'asc' ? 'asc' : 'desc' })
              }
            />
          </div>
          <div className="min-w-32 flex-1 sm:w-36 sm:flex-none">
            <Select
              label="Baris per halaman"
              options={withFallbackOption(
                AUDIT_LIMIT_OPTIONS,
                String(filter.limit ?? AUDIT_PAGE_LIMIT),
                `${filter.limit ?? AUDIT_PAGE_LIMIT} baris`,
              )}
              value={String(filter.limit ?? AUDIT_PAGE_LIMIT)}
              onChange={(event) =>
                updateFilter({ limit: normaliseAuditLimit(event.target.value) })
              }
            />
          </div>
          <div data-testid="audit-filter-reset">
            <FilterResetButton onReset={handleResetFilters} disabled={!hasActiveFilter} />
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-44 flex-1 sm:w-56 sm:flex-none">
            <Select
              label="Pelaku"
              options={withFallbackOption(
                actorOptions,
                filter.userId,
                auditActorLabel(filter.userId, usersById),
              )}
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
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-36 flex-1 sm:w-44 sm:flex-none">
            <Input
              label="Dari Tanggal"
              type="date"
              value={filter.dateFrom}
              max={filter.dateTo !== '' ? filter.dateTo : undefined}
              error={rangeInverted ? 'Tanggal awal melewati tanggal akhir.' : undefined}
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
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label font-semibold text-ink-secondary">Rentang cepat</span>
            {[
              { label: 'Hari ini', range: presetToday },
              { label: '7 hari', range: presetWeek },
              { label: '30 hari', range: presetMonth },
            ].map((preset) => {
              const active =
                filter.dateFrom === preset.range.dateFrom &&
                filter.dateTo === preset.range.dateTo
              return (
                <Button
                  key={preset.label}
                  variant={active ? 'primary' : 'secondary'}
                  className="min-h-touch"
                  aria-pressed={active}
                  onClick={() => updateFilter(preset.range)}
                >
                  {preset.label}
                </Button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="mt-4">
        {rangeInverted ? (
          <div className="card">
            <EmptyState
              icon={<AlertTriangle aria-hidden="true" className="size-8" />}
              title="Rentang tanggal tidak valid"
              description="Tanggal awal tidak boleh melewati tanggal akhir. Perbaiki rentang atau reset filter."
              action={
                <Button
                  variant="secondary"
                  className="min-h-touch"
                  data-testid="audit-range-reset"
                  onClick={handleResetFilters}
                >
                  Reset Filter
                </Button>
              }
            />
          </div>
        ) : auditQuery.isPending ? (
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
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="min-h-touch"
                onClick={() => void auditQuery.refetch()}
              >
                Coba Lagi
              </Button>
              <Button
                variant="secondary"
                className="min-h-touch"
                data-testid="audit-error-reset"
                disabled={!hasActiveFilter}
                onClick={handleResetFilters}
              >
                Reset Filter
              </Button>
            </div>
          </div>
        ) : (
          <>
            {items.length === 0 ? (
              <div className="card">
                <EmptyState
                  icon={<Inbox aria-hidden="true" className="size-8" />}
                  title={pageOutOfRange ? 'Halaman ini kosong' : emptyTitle}
                  description={
                    pageOutOfRange
                      ? `Halaman ${page} melewati halaman terakhir (${totalPages}) dari ${total} jejak.`
                      : emptyDescription
                  }
                  action={
                    pageOutOfRange ? (
                      <Button
                        variant="primary"
                        className="min-h-touch"
                        onClick={() => setPage(totalPages)}
                      >
                        Ke halaman terakhir
                      </Button>
                    ) : hasActiveFilter ? (
                      <Button
                        variant="secondary"
                        className="min-h-touch"
                        data-testid="audit-empty-reset"
                        onClick={handleResetFilters}
                      >
                        Reset Filter
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <>
                <AuditTable items={items} usersById={usersById} onSelect={handleSelectLog} />
                <AuditCards items={items} usersById={usersById} onSelect={handleSelectLog} />
              </>
            )}

            {total > 0 ? (
              <Pagination
                ariaLabel="Paginasi jejak audit"
                page={safePage}
                totalPages={totalPages}
                onPageChange={setPage}
                className="mt-4"
              />
            ) : null}
          </>
        )}
      </div>

      <AuditDetailModal
        log={selectedLog}
        usersById={usersById}
        onClose={() => setSelectedLog(null)}
      />
    </SuperadminShell>
  )
}

// ---------------------------------------------------------------------------
// Tabel desktop (>= 1024px) + kartu responsif: ponsel (< 768px) tumpukan
// vertikal 1 kolom, tablet (768px - 1023px) grid 2 kolom — tanpa scroll.
// ---------------------------------------------------------------------------

interface AuditListProps {
  items: AuditLog[]
  usersById: ReadonlyMap<string, AuditActorInfo>
  /** Membuka (atau menutup lewat toggle) modal detail untuk baris ini. */
  onSelect: (log: AuditLog) => void
}

/**
 * Aktivasi baris via keyboard (Enter/Space). `role="button"` tidak sah pada
 * `<tr>` di dalam tabel (melanggar model tabel), jadi baris cukup `tabIndex`
 * + handler ini — cincin fokus datang dari `:focus-visible` global di
 * globals.css, tanpa ARIA tambahan yang berisiko salah.
 */
function activateRowOnKeyDown(
  event: KeyboardEvent<HTMLElement>,
  activate: () => void,
): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault() // Space tidak boleh menggulir halaman
    activate()
  }
}

function AuditTable({ items, usersById, onSelect }: AuditListProps) {
  return (
    <div className={TABLE_WRAPPER_CLASS}>
      <table className={TABLE_CLASS}>
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
                className={`${header.width} ${TABLE_TH_CLASS}`}
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
              tabIndex={0}
              className="cursor-pointer transition-colors hover:bg-brand/5"
              onClick={() => onSelect(log)}
              onKeyDown={(event) => activateRowOnKeyDown(event, () => onSelect(log))}
            >
              <td className={TABLE_TD_CLASS}>
                <p className="whitespace-nowrap text-xs sm:text-sm text-ink">
                  {formatTanggalWaktu(log.timestamp)}
                </p>
              </td>
              <td className={TABLE_TD_CLASS}>
                <p
                  className="truncate text-xs sm:text-sm font-semibold text-ink"
                  title={log.user_id ?? undefined}
                >
                  {auditActorLabelHonest(log, usersById)}
                </p>
              </td>
              <td className={TABLE_TD_CLASS}>
                <Badge tone={auditActionTone(log.action)}>
                  {auditActionLabel(log.action)}
                </Badge>
              </td>
              <td className={TABLE_TD_CLASS}>
                <Badge tone="neutral">{auditEntityLabel(log.entity)}</Badge>
              </td>
              <td className={TABLE_TD_CLASS}>
                <p className="truncate text-xs sm:text-sm tabular-nums text-ink-secondary" title={log.ip}>
                  {log.ip !== '' ? log.ip : '—'}
                </p>
              </td>
              <td className={TABLE_TD_CLASS}>
                <p
                  className="truncate text-xs sm:text-sm text-ink-secondary"
                  title={auditMetadataPairSummary(log.metadata)}
                >
                  {auditImpactSentence(log, auditActorLabelHonest(log, usersById))}
                </p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AuditCards({ items, usersById, onSelect }: AuditListProps) {
  return (
    <ul className={TABLE_CARD_LIST_CLASS}>
      {items.map((log) => (
        <li
          key={log.id}
          tabIndex={0}
          className="card flex cursor-pointer flex-col p-4 transition-colors hover:bg-brand/5"
          onClick={() => onSelect(log)}
          onKeyDown={(event) => activateRowOnKeyDown(event, () => onSelect(log))}
        >
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
                {auditActorLabelHonest(log, usersById)}
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Tag className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="min-w-0 wrap-anywhere">{auditEntityLabel(log.entity)}</span>
            </p>
            <p className="flex items-start gap-2">
              <Server className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="min-w-0 tabular-nums wrap-anywhere">
                {log.ip !== '' ? log.ip : '—'}
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span
                className="min-w-0 wrap-anywhere"
                title={auditMetadataPairSummary(log.metadata)}
              >
                {auditImpactSentence(log, auditActorLabelHonest(log, usersById))}
              </span>
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}
