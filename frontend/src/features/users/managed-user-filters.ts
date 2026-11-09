import type { SelectOption } from '@/components/ui/Select'
import type { ManagedUserListParams, ManagedUserRole, User } from '@/lib/api/types'
import { can, getRoleLabel, type Role } from '@/lib/auth/capabilities'

/**
 * Helper murni untuk layar "user terkelola" milik superadmin.
 *
 * SATU modul ini melayani SEMUA halaman user terkelola:
 * `/coordinators` → `admin` + `super_admin`, `/vendor-registrations` →
 * `vendor`. Layar `/users` lama (yang isinya satu akun `super_admin` saja)
 * sudah dihapus; akun tingkat atas kini tampil berdampingan dengan
 * Koordinator Wilayah dan dibedakan lewat filter peran di kolom "Peran".
 *
 * Modul ini TIDAK bereaksi terhadap React — seluruh isinya predikat murni
 * yang bisa diuji tanpa DOM.
 */

// ---------------------------------------------------------------------------
// Dev-account hiding (single source of truth)
// ---------------------------------------------------------------------------

/** Surel akun dev-superadmin yang tersembunyi (drifted prod account). */
export const DEV_SUPERADMIN_EMAIL = 'dev-superadmin@transhybrid.net.id'

/**
 * Akun dev yang disembunyikan dari semua layar user terkelola: peran
 * `dev-superadmin` ATAU surel yang cocok (case-insensitive) dengan
 * `DEV_SUPERADMIN_EMAIL`. Satu sumber kebenaran — dipakai di kedua drop
 * (`filterManagedUsersByRoles` dan `applyManagedUserFilters`).
 */
export function isHiddenDevUser(user: Pick<User, 'role' | 'email'>): boolean {
  return user.role === 'dev-superadmin' || user.email.toLowerCase() === DEV_SUPERADMIN_EMAIL
}
// ---------------------------------------------------------------------------
// Peran
// ---------------------------------------------------------------------------

/**
 * Filter peran pada layar user terkelola: '' = Semua.
 *
 * `security` DIKECUALIKAN — announya di `/security`. `super_admin` ikut
 * masuk daftar karena akun tingkat atas (Kantor Pusat) kini tampil
 * berdampingan dengan Koordinator Wilayah di satu tabel.
 */
export type ManagedRoleFilter = '' | 'admin' | 'vendor' | 'super_admin'

/**
 * Peran yang DICAKUP satu layar user terkelola. Satu layar dapat mencakup
 * lebih dari satu peran (`/coordinators` = `admin` + `super_admin`) —
 * pembedaan peran dibuat lewat filter peran di kolom "Peran", bukan lewat
 * halaman per-peran.
 */
export type ManagedPageRole = 'super_admin' | 'admin' | 'vendor'

/**
 * Peran yang boleh dikirim sebagai query param `GET /users?role=`.
 *
 * Backend (`ValidateUserListRole`, usecase/superadmin) hanya menerima
 * `admin|vendor|security` — `super_admin` ditolak dengan 400. Karena itu
 * akun tingkat atas TIDAK requesting `?role=super_admin`, melainkan disaring
 * di KLIEN (lihat `filterManagedUsersByRoles`).
 */
const SERVER_FILTERABLE_ROLES: ReadonlySet<string> = new Set(['admin', 'vendor', 'security'])


/** Lokasi penugasan wajib iff peran `admin`; disembunyikan iff `vendor` (kontrak §2). */
export function requiresManagedLocation(role: ManagedRoleFilter | ManagedUserRole): boolean {
  return role === 'admin'
}

// ---------------------------------------------------------------------------
// Filter peran (kolom "Peran")
// ---------------------------------------------------------------------------

/** Sentinel "Semua Peran" untuk filter peran. */
export const ROLE_FILTER_ALL = ''

/**
 * Opsi filter peran untuk halaman yang mencakup lebih dari satu peran:
 * "Semua Peran" diikuti satu entri per peran halaman. Label memakai
 * `getRoleLabel` sehingga konsisten dengan badge peran di seluruh aplikasi.
 */
export function managedRoleFilterOptions(roles: readonly ManagedPageRole[]): SelectOption[] {
  return [
    { value: ROLE_FILTER_ALL, label: 'Semua Peran' },
    ...roles.map((role) => ({ value: role, label: getRoleLabel(role) })),
  ]
}

/**
 * Nilai filter peran dari kontrol `<select>` — nilai di luar daftar peran
 * yang dikenal jatuh ke "Semua Peran" (tak pernah melempar).
 */
export function parseManagedRoleFilter(raw: string): ManagedRoleFilter {
  switch (raw) {
    case 'admin':
      return 'admin'
    case 'vendor':
      return 'vendor'
    case 'super_admin':
      return 'super_admin'
    default:
      return ROLE_FILTER_ALL
  }
}

/**
 * Peran efektif sebuah layar: seluruh peran halaman bila filter masih
 * "Semua Peran", atau satu peran bila superadmin memilih peran tertentu.
 */
export function effectiveManagedRoles(
  roles: readonly ManagedPageRole[],
  roleFilter: ManagedRoleFilter,
): ManagedPageRole[] {
  if (roleFilter === ROLE_FILTER_ALL) return [...roles]
  return roles.includes(roleFilter) ? [roleFilter] : [...roles]
}

/**
 * Peran yang DIQUERY ke server untuk satu set peran halaman.
 *
 * Backend hanya menerima SATU peran pada `GET /users?role=` dan menolak
 * `super_admin` (400). Karena itu halaman yang mencakup lebih dari satu
 * peran meminta TANPA param `role`, lalu menyaring barisnya di klien.
 */
export function managedServerRoleParam(roles: readonly ManagedPageRole[]): ManagedRoleFilter {
  if (roles.length !== 1) return ROLE_FILTER_ALL
  const only = roles[0]
  if (only === undefined) return ROLE_FILTER_ALL
  return SERVER_FILTERABLE_ROLES.has(only) ? only : ROLE_FILTER_ALL
}

/**
 * Saring baris ke set peran efektif. `security` selalu dibuang (rumahnya
 * di `/security`), jadi peran itu tak perlu masuk daftar peran halaman.
 * `dev-superadmin` yang tersembunyi SELALU dibuang — tak ada layar yang
 * boleh merendernya, apa pun set peran halamannya.
 */
export function filterManagedUsersByRoles(
  users: User[],
  roles: readonly ManagedPageRole[],
): User[] {
  return users.filter((user) => {
    const role = user.role
    if (role === 'security') return false
    if (isHiddenDevUser(user)) return false
    return roles.includes(role as ManagedPageRole)
  })
}

/**
 * Peran yang boleh dibuat lewat `POST /users` (backend hanya menerima
 * `admin|vendor`). Akun `super_admin` tak bisa dibuat dari sistem, jadi
 * tombol tambah disembunyikan saat peran itu yang dipilih.
 *
 * Saat filter "Semua Peran", dipakai peran pertama yang bisa dibuat pada
 * halaman itu (`admin` untuk Koordinator Wilayah, `vendor` untuk Pendaftaran
 * Vendor/Mitra).
 */
export function managedCreateRole(
  roles: readonly ManagedPageRole[],
  roleFilter: ManagedRoleFilter,
): ManagedUserRole | null {
  if (roleFilter !== ROLE_FILTER_ALL) {
    return roleFilter === 'super_admin' ? null : roleFilter
  }
  for (const role of roles) {
    if (role === 'admin' || role === 'vendor') return role
  }
  return null
}

/**
 * Filter cabang relevan HANYA bila peran efektif memuat `admin` — akun
 * `vendor` & `super_admin` tak punya penugasan cabang (kontrak §2).
 */
export function managedLocationFilterApplies(roles: readonly ManagedPageRole[]): boolean {
  return roles.some((role) => requiresManagedLocation(role))
}

// ---------------------------------------------------------------------------
// Afiliasi (cabang / vendor)
// ---------------------------------------------------------------------------

/**
 * Id cakupan cabang user (union multi-cabang): `location_ids[]` bila terisi,
 * fallback `[location_id]`, fallback `[]`. Satu sumber untuk predikat
 * union-aware (guard hapus, filter cabang, label afiliasi).
 */
export function userLocationIds(
  user: Pick<User, 'location_id' | 'location_ids'>,
): string[] {
  if (user.location_ids !== undefined && user.location_ids.length > 0) {
    return [...user.location_ids]
  }
  return user.location_id !== null ? [user.location_id] : []
}

/**
 * Gabung daftar user multi-cabang dengan dedupe per id (urutan pertama
 * menang). Dipakai daftar pengawas multi-branch: admin dengan cakupan
 * `location_ids[]` meminta tiap cabang lalu digabung di sini.
 */
export function mergeUsersById(lists: ReadonlyArray<ReadonlyArray<User>>): User[] {
  const seen = new Set<string>()
  const merged: User[] = []
  for (const list of lists) {
    for (const user of list) {
      if (seen.has(user.id)) continue
      seen.add(user.id)
      merged.push(user)
    }
  }
  return merged
}

/** Afiliasi mentah union-aware: "N cabang", nama cabang tunggal, nama vendor, atau `null`. */
export function userAffiliationValue(
  user: User,
  locations: ReadonlyArray<{ id: string; name: string }> = [],
): string | null {
  const branchNames = userBranchNames(user, locations)
  if (branchNames.length > 1) return `${branchNames.length} cabang`
  if (branchNames.length === 1) {
    const only = branchNames[0]
    if (only !== undefined) {
      const isUnresolvedId = userLocationIds(user).includes(only)
        && only === user.location_id
        && (user.location_name === null || user.location_name === '')
        && !locations.some((loc) => loc.id === only && loc.name !== '')
      if (!isUnresolvedId) return only
    }
  }
  if (user.vendor_name !== null && user.vendor_name !== '') return user.vendor_name
  return null
}

/** Kolom Cabang/Vendor union-aware: "N cabang", nama cabang, nama vendor, atau strip. */
export function userAffiliationLabel(
  user: User,
  locations: ReadonlyArray<{ id: string; name: string }> = [],
): string {
  return userAffiliationValue(user, locations) ?? '—'
}

/**
 * Judul tooltip afiliasi: nama SELURUH cabang digabung (detail
 * multi-cabang), atau nama vendor, atau strip. Dipakai atribut `title`
 * pada tabel/kartu pendamping label "N cabang".
 */
export function userAffiliationTitle(
  user: User,
  locations: ReadonlyArray<{ id: string; name: string }> = [],
): string {
  const branchNames = userBranchNames(user, locations)
  if (branchNames.length === 1) {
    const only = branchNames[0]
    const isUnresolvedId = only !== undefined
      && userLocationIds(user).includes(only)
      && only === user.location_id
      && (user.location_name === null || user.location_name === '')
      && !locations.some((loc) => loc.id === only && loc.name !== '')
    if (isUnresolvedId) {
      if (user.vendor_name !== null && user.vendor_name !== '') return user.vendor_name
      return '—'
    }
  }
  if (branchNames.length > 0) return branchNames.join(', ')
  if (user.vendor_name !== null && user.vendor_name !== '') return user.vendor_name
  return '—'
}

/**
 * Nama SELURUH cabang dalam cakupan user (model hibrida: `location_ids[]`
 * dengan `location_id` sebagai primer), diurutkan sesuai urutan cakupan
 * (lokasi utama dahulu). Dipakai baris "CABANG" pada modal detail supaya
 * multi-cabang tak pernah hanya menampilkan cabang pertama.
 *
 * Resolusi nama memakai katalog `GET /locations`; cabang primer yang tak
 * ada di katalog jatuh ke `location_name`, cabang lain yang hilang dari
 * katalog tetap ditampilkan berupa id-nya (tak pernah dibuang diam-diam).
 * `[]` bila tanpa cakupan (super_admin / vendor) — pemanggil yang
 * menentukan strip atau fallback vendor.
 */
export function userBranchNames(
  user: Pick<User, 'location_id' | 'location_ids' | 'location_name'>,
  locations: ReadonlyArray<{ id: string; name: string }> = [],
): string[] {
  const scope =
    user.location_ids !== undefined && user.location_ids.length > 0
      ? user.location_ids
      : user.location_id !== null
        ? [user.location_id]
        : []
  if (scope.length === 0) return []
  const nameById = new Map(locations.map((location) => [location.id, location.name]))
  return scope.map((id) => {
    const name = nameById.get(id)
    if (name !== undefined && name !== '') return name
    if (id === user.location_id && user.location_name !== null && user.location_name !== '') {
      return user.location_name
    }
    return id
  })
}

// ---------------------------------------------------------------------------
// Query `GET /users`
// ---------------------------------------------------------------------------

export interface ManagedListFilter {
  role: ManagedRoleFilter
  search: string
  locationId: string
}

/**
 * Normalisasi filter UI menjadi query `GET /users` — string kosong
 * dihilangkan agar tidak terkirim sebagai param (kontrak §2).
 *
 * Param `role` hanya diisi untuk peran yang diterima backend
 * (`admin|vendor|security`); peran `super_admin` difilter di klien.
 */
export function toManagedUserListParams(filter: ManagedListFilter): ManagedUserListParams {
  const params: ManagedUserListParams = {}
  if (filter.role !== '' && SERVER_FILTERABLE_ROLES.has(filter.role)) params.role = filter.role
  if (filter.search.trim() !== '') params.search = filter.search.trim()
  if (filter.locationId !== 'all') params.location_id = filter.locationId
  return params
}

/** Filter status pada layar user terkelola; 'all' = semua status. */
export type ManagedStatusFilter = 'all' | 'active' | 'pending' | 'inactive' | 'blacklisted'

/** Sentinel "semua" untuk filter Vendor (selaras dengan filter Cabang). */
export const VENDOR_FILTER_ALL = 'all'

/**
 * Opsi dropdown Vendor = nama vendor unik dari user vendor yang SUDAH dimuat,
 * bukan dari katalog: user dengan vendor_name manual (di luar katalog) tetap
 * bisa difilter. Kolom yang dicocokkan persis kolom yang ditampilkan tabel.
 */
export function managedVendorOptions(users: User[]): SelectOption[] {
  const names = new Set<string>()
  for (const user of users) {
    if (user.role !== 'vendor') continue
    const name = (user.vendor_name ?? '').trim()
    if (name !== '') names.add(name)
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'id'))
  return [
    { value: VENDOR_FILTER_ALL, label: 'Semua Vendor' },
    ...sorted.map((name) => ({ value: name, label: name })),
  ]
}

/**
 * Filter client-side daftar user: buang security dan `dev-superadmin` yang
 * tersembunyi, lalu terapkan status ('all' = tanpa filter) dan vendor
 * exact-match ('all' = tanpa filter).
 */
export function applyManagedUserFilters(
  users: User[],
  filter: { status: ManagedStatusFilter; vendor: string },
): User[] {
  return users.filter((user) => {
    if (user.role === 'security') return false
    if (isHiddenDevUser(user)) return false
    if (filter.status !== 'all' && user.status !== filter.status) return false
    if (filter.vendor !== VENDOR_FILTER_ALL && (user.vendor_name ?? '') !== filter.vendor) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Guard aksi baris
// ---------------------------------------------------------------------------

/**
 * Akun yang dilindungi dari aksi merusak: akun sendiri, akun `super_admin`,
 * dan akun `dev-superadmin` yang tersembunyi. Kontrak
 * `PATCH /users/{id}/status` dan `DELETE /users/{id}` sama-sama membalas 403
 * untuk ketiganya, jadi satu guard dipakai dua aksi. Guard peran
 * (`can(role, ...)`) dicek terpisah di layar.
 */
export function isProtectedUser(target: User, currentUserId: string | null): boolean {
  if (currentUserId !== null && target.id === currentUserId) return true
  return target.role === 'super_admin' || target.role === 'dev-superadmin'
}

/**
 * Baris user boleh menampilkan tombol hapus: bukan akun sendiri dan bukan
 * akun `super_admin` (kontrak DELETE /users/{id} → 403 untuk keduanya).
 * Guard peran (`can(role, 'deleteRecords')`) dicek terpisah di layar.
 */
export function isDeletableUser(target: User, currentUserId: string | null): boolean {
  return !isProtectedUser(target, currentUserId)
}

/** Tombol hapus tampil iff peran boleh hapus DAN baris boleh dihapus. */
export function canShowDeleteUser(role: Role, target: User, currentUserId: string | null): boolean {
  return can(role, 'deleteRecords') && isDeletableUser(target, currentUserId)
}

/** Pesan konfirmasi hapus user — menyebut nama agar tidak salah sasaran. */
export function deleteUserConfirmMessage(target: User): string {
  return `Hapus permanen akun "${target.name}" (${target.email})? Tindakan ini tidak dapat dibatalkan.`
}

// ---------------------------------------------------------------------------
// Pagination: kontrak reset halaman saat filter berubah
// ---------------------------------------------------------------------------

/**
 * Snapshot nilai yang menentukan isi daftar user (filter bar + ukuran halaman).
 * `roleFilter` = filter peran di kolom "Peran" ('' = "Semua Peran").
 */
export interface UserFilterSnapshot {
  roleFilter: ManagedRoleFilter
  locationId: string
  search: string
  statusFilter: ManagedStatusFilter
  vendorFilter: string
  pageSize: number
}

/**
 * Nilai penentu halaman: perubahan salah satunya mengembalikan daftar ke
 * halaman 1 (kunci SAMA PERSIS dengan dependency effect reset di layar user
 * terkelola). Filter peran termasuk di dalamnya karena menukar peran
 * mengubah isi tabel.
 */
export const USER_FILTER_DEP_KEYS = [
  'roleFilter',
  'locationId',
  'search',
  'statusFilter',
  'vendorFilter',
  'pageSize',
] as const satisfies readonly (keyof UserFilterSnapshot)[]

/** `true` bila ada satu nilai penentu halaman yang berubah (predikat murni, dapat diuji). */
export function shouldResetUserPage(
  prev: UserFilterSnapshot,
  next: UserFilterSnapshot,
): boolean {
  return USER_FILTER_DEP_KEYS.some((key) => prev[key] !== next[key])
}
