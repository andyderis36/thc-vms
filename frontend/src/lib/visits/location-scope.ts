/**
 * Isolasi katalog fasilitas pada dropdown "Fasilitas Tujuan" (SCR-03).
 *
 * `GET /locations` bersifat global-by-design (master data lintas cabang,
 * dipakai bersama konsol `super_admin` dan form `vendor`), sehingga
 * penyempitan per-pemanggil dilakukan di sini — bukan di backend.
 *
 * Aturan scoping (lihat `DECISION-hole-1-location-scope.md`):
 * - `admin` / `security` → HANYA fasilitas dalam cakupan sesi:
 *   `location_ids ?? [location_id]` (model hibrida multi-cabang).
 * - `super_admin` → seluruh katalog nasional (lintas cabang).
 * - `vendor` → tidak difilter (perilaku lama dipertahankan).
 *
 * Bila peran ter-scope kebetulan punya cakupan KOSONG (`location_id`
 * `null` tanpa `location_ids`), filter menghasilkan daftar KOSONG — katalog
 * nasional tidak pernah bocor ke peran cabang; UI menampilkan pilihan
 * terkunci.
 */

import type { SelectOption } from '@/components/ui/Select'
import type { Location, Role, User } from '@/lib/api/types'

/** Peran yang datanya terisolasi per cabang (`WHERE location_id = user.location_id`). */
export function isLocationScopedRole(role: Role): boolean {
  return role === 'admin' || role === 'security'
}

/**
 * Cakupan lokasi sesi: `location_ids ?? [location_id]` untuk peran
 * ter-scope, atau `null` untuk peran tanpa isolasi (`super_admin`,
 * `vendor`, `dev-superadmin`) yang berarti "seluruh katalog".
 *
 * `null` ≠ `[]`: `null` = tanpa filter, `[]` = ter-scope tapi belum
 * ter-resolve (dropdown kosong & terkunci).
 */
export function sessionScopeLocationIds(
  user: Pick<User, 'role' | 'location_id' | 'location_ids'>,
): string[] | null {
  if (!isLocationScopedRole(user.role)) return null
  if (user.location_ids !== undefined && user.location_ids.length > 0) {
    return [...user.location_ids]
  }
  return user.location_id !== null ? [user.location_id] : []
}

/**
 * True bila peran ter-scope (`admin`/`security`) namun cakupannya belum
 * ter-resolve (tanpa `location_ids` DAN `location_id` `null`) — dropdown
 * wajib kosong dan terkunci.
 */
export function isLocationScopeUnresolved(
  user: Pick<User, 'role' | 'location_id' | 'location_ids'>,
): boolean {
  const scope = sessionScopeLocationIds(user)
  return scope !== null && scope.length === 0
}

/**
 * Saring katalog lokasi ke cakupan sesi pemanggil (isolasi peran §6.1).
 *
 * @param locations katalog dari `GET /locations`.
 * @param user minimal `{ role, location_id[, location_ids] }` pengguna sesi aktif.
 * @returns lokasi yang boleh dilihat pengguna; `[]` bila cakupan kosong.
 */
export function scopeLocations<T extends { id: string }>(
  locations: readonly T[],
  user: Pick<User, 'role' | 'location_id' | 'location_ids'>,
): T[] {
  const scope = sessionScopeLocationIds(user)
  if (scope === null) return [...locations]
  return locations.filter((location) => scope.includes(location.id))
}

/**
 * Petakan katalog lokasi menjadi opsi dropdown sesuai isolasi peran.
 *
 * @param locations katalog dari `GET /locations`.
 * @param user minimal `{ role, location_id[, location_ids] }` pengguna sesi aktif.
 * @returns opsi yang boleh dilihat pengguna; `[]` bila cakupan kosong.
 */
export function scopeLocationOptions(
  locations: readonly Location[],
  user: Pick<User, 'role' | 'location_id' | 'location_ids'>,
): SelectOption[] {
  return scopeLocations(locations, user).map((location) => ({
    value: location.id,
    label: buildLocationLabel(location),
  }))
}

/**
 * Opsi filter cabang untuk bar filter halaman (dashboard, approvals).
 *
 * Sentinel `'all'` di depan — labelnya berbeda per peran ("Semua Cabang / POP"
 * untuk lintas cabang, "Semua Cabang Saya" untuk peran ter-scope) — diikuti
 * HANYA lokasi dalam cakupan sesi. Superadmin/vendor menerima katalog penuh,
 * admin/security menerima `location_ids ?? [location_id]`; cakupan kosong
 * menyisakan sentinel saja sehingga kontrol bisa dikunci pemanggil.
 */
export function branchFilterOptions(
  locations: readonly Location[],
  user: Pick<User, 'role' | 'location_id' | 'location_ids'>,
  allLabel: string,
): SelectOption[] {
  return [
    { value: 'all', label: allLabel },
    ...scopeLocations(locations, user).map((location) => ({
      value: location.id,
      label: location.name,
    })),
  ]
}

/**
 * Susun label opsi lokasi tanpa menduplikasi kota.
 *
 * Suffix ` — {city}` hanya ditambahkan bila `city` non-kosong DAN namanya
 * belum memuat kota tersebut (pencocokan case-insensitive `contains`, bukan
 * `endsWith`, agar `(Pontianak)` di tengah nama tetap terdeteksi).
 */
function buildLocationLabel(location: Location): string {
  const city = location.city.trim()
  if (city === '' || location.name.toLowerCase().includes(city.toLowerCase())) {
    return location.name
  }
  return `${location.name} — ${city}`
}
