/**
 * Isolasi katalog fasilitas pada dropdown "Fasilitas Tujuan" (SCR-03).
 *
 * `GET /locations` bersifat global-by-design (master data lintas cabang,
 * dipakai bersama konsol `super_admin` dan form `vendor`), sehingga
 * penyempitan per-pemanggil dilakukan di sini — bukan di backend.
 *
 * Aturan scoping (lihat `DECISION-hole-1-location-scope.md`):
 * - `admin` / `security` → HANYA fasilitas `id === user.location_id`.
 * - `super_admin` → seluruh katalog nasional (lintas cabang).
 * - `vendor` → tidak difilter (perilaku lama dipertahankan).
 *
 * Bila peran ter-scope kebetulan punya `location_id` `null`, filter
 * menghasilkan daftar KOSONG — katalog nasional tidak pernah bocor ke
 * peran cabang; UI menampilkan pilihan terkunci.
 */

import type { SelectOption } from '@/components/ui/Select'
import type { Location, Role, User } from '@/lib/api/types'

/** Peran yang datanya terisolasi per cabang (`WHERE location_id = user.location_id`). */
export function isLocationScopedRole(role: Role): boolean {
  return role === 'admin' || role === 'security'
}

/**
 * True bila peran ter-scope (`admin`/`security`) namun lokasinya belum
 * ter-resolve (`location_id` `null`) — dropdown wajib kosong dan terkunci.
 */
export function isLocationScopeUnresolved(
  user: Pick<User, 'role' | 'location_id'>,
): boolean {
  return isLocationScopedRole(user.role) && user.location_id === null
}

/**
 * Petakan katalog lokasi menjadi opsi dropdown sesuai isolasi peran.
 *
 * @param locations katalog dari `GET /locations`.
 * @param user minimal `{ role, location_id }` pengguna sesi aktif.
 * @returns opsi yang boleh dilihat pengguna; `[]` bila cabang tak ter-resolve.
 */
export function scopeLocationOptions(
  locations: readonly Location[],
  user: Pick<User, 'role' | 'location_id'>,
): SelectOption[] {
  const visible = isLocationScopedRole(user.role)
    ? locations.filter((location) => location.id === user.location_id)
    : locations
  return visible.map((location) => ({
    value: location.id,
    label: buildLocationLabel(location),
  }))
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
