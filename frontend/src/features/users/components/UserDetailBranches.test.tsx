// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { DetailField } from '@/components/ui/DetailModal'
import type { User } from '@/lib/api/types'
import { securityUserDetailFields } from '@/features/security/components/SecurityUserModal'
import { managedUserDetailFields } from './ManagedUserTable'

/**
 * Kontrak baris detail multi-cabang (model hibrida `location_id` +
 * `location_ids[]`):
 * - "CABANG / VENDOR" (Detail User) & "CABANG" (Detail Pengawas) menampilkan
 *   SEMUA cabang cakupan sebagai pil — tak pernah hanya cabang pertama;
 * - cakupan tunggal -> tepat satu pil (fallback single);
 * - cakupan kosong -> vendor_name / `location_name` / strip (empty-safe).
 */

const LOCATIONS = [
  { id: 'loc-sby', name: 'Kantor Pusat Surabaya' },
  { id: 'loc-mlg', name: 'Cabang Malang' },
  { id: 'loc-swj', name: 'POP Singkawang' },
]

function userStub(overrides: Partial<User> = {}): User {
  return {
    id: 'usr-1',
    name: 'Agus Setiawan',
    email: 'agus@thc.id',
    phone: '08111111111',
    nik: '3512345678901234',
    role: 'admin',
    location_id: 'loc-sby',
    location_ids: ['loc-sby', 'loc-mlg'],
    location_name: 'Kantor Pusat Surabaya',
    status: 'active',
    type: 'internal',
    vendor_name: null,
    avatar_url: null,
    ...overrides,
  }
}

/** Ambil nilai baris label tertentu dari daftar field detail. */
function fieldValue(fields: DetailField[], label: string): ReactNode {
  const field = fields.find((entry) => entry.label === label)
  expect(field, `field "${label}" tidak ditemukan`).toBeDefined()
  return field?.value
}

/** Render nilai satu baris field ke DOM (untuk menghitung pil status-badge). */
function renderValue(value: ReactNode) {
  return render(<>{value}</>)
}

afterEach(cleanup)

describe('managedUserDetailFields — CABANG / VENDOR multi-cabang', () => {
  it('admin dua cabang -> DUA pil, bukan hanya cabang pertama', () => {
    const fields = managedUserDetailFields(userStub(), LOCATIONS)
    const { container } = renderValue(fieldValue(fields, 'CABANG / VENDOR'))

    const pills = container.querySelectorAll('.status-badge')
    expect(pills).toHaveLength(2)
    expect(pills[0]).toHaveTextContent('Kantor Pusat Surabaya')
    expect(pills[1]).toHaveTextContent('Cabang Malang')
    expect(container.textContent).not.toContain('POP Singkawang')
  })

  it('cakupan tunggal (location_ids absen) -> tepat satu pil', () => {
    const single = userStub({ location_id: 'loc-mlg', location_ids: undefined, location_name: 'Cabang Malang' })
    const fields = managedUserDetailFields(single, LOCATIONS)
    const { container } = renderValue(fieldValue(fields, 'CABANG / VENDOR'))

    const pills = container.querySelectorAll('.status-badge')
    expect(pills).toHaveLength(1)
    expect(pills[0]).toHaveTextContent('Cabang Malang')
  })

  it('cabang primer absen dari katalog -> jatuh ke location_name (tak pernah hilang)', () => {
    const odd = userStub({ location_id: 'loc-x', location_ids: ['loc-x'], location_name: 'POP Belum Katalog' })
    const { container } = renderValue(
      fieldValue(managedUserDetailFields(odd, LOCATIONS), 'CABANG / VENDOR'),
    )
    expect(container.textContent).toContain('POP Belum Katalog')
  })

  it('cabang sekunder absen dari katalog -> id tetap tampil (tak dibuang diam-diam)', () => {
    const odd = userStub({ location_ids: ['loc-sby', 'loc-ghost'] })
    const { container } = renderValue(
      fieldValue(managedUserDetailFields(odd, LOCATIONS), 'CABANG / VENDOR'),
    )
    expect(container.textContent).toContain('Kantor Pusat Surabaya')
    expect(container.textContent).toContain('loc-ghost')
  })

  it('super_admin tanpa cabang & tanpa vendor -> null (strip pada DetailModal)', () => {
    const superAdmin = userStub({
      role: 'super_admin',
      location_id: null,
      location_ids: undefined,
      location_name: null,
      nik: null,
    })
    const fields = managedUserDetailFields(superAdmin, LOCATIONS)
    expect(fieldValue(fields, 'CABANG / VENDOR')).toBeNull()
  })

  it('vendor tanpa cabang -> nama vendor (bukan strip, bukan pil)', () => {
    const vendor = userStub({
      role: 'vendor',
      location_id: null,
      location_ids: undefined,
      location_name: null,
      vendor_name: 'PT Lintas Fiber',
      type: 'external',
    })
    expect(fieldValue(managedUserDetailFields(vendor, LOCATIONS), 'CABANG / VENDOR')).toBe(
      'PT Lintas Fiber',
    )
  })

  it('tanpa katalog pun nama cabang primer tetap tampil (fallback location_name)', () => {
    const fields = managedUserDetailFields(userStub({ location_ids: undefined }), [])
    const { container } = renderValue(fieldValue(fields, 'CABANG / VENDOR'))
    expect(container.textContent).toContain('Kantor Pusat Surabaya')
  })
})

describe('securityUserDetailFields — CABANG multi-cabang', () => {
  it('pengawas dua cabang -> DUA pil, bukan hanya cabang pertama', () => {
    const fields = securityUserDetailFields(userStub({ role: 'security', nik: null }), LOCATIONS)
    const { container } = renderValue(fieldValue(fields, 'CABANG'))

    const pills = container.querySelectorAll('.status-badge')
    expect(pills).toHaveLength(2)
    expect(pills[0]).toHaveTextContent('Kantor Pusat Surabaya')
    expect(pills[1]).toHaveTextContent('Cabang Malang')
  })

  it('cakupan tunggal -> tepat satu pil', () => {
    const single = userStub({
      role: 'security',
      nik: null,
      location_id: 'loc-swj',
      location_ids: undefined,
      location_name: 'POP Singkawang',
    })
    const { container } = renderValue(
      fieldValue(securityUserDetailFields(single, LOCATIONS), 'CABANG'),
    )
    const pills = container.querySelectorAll('.status-badge')
    expect(pills).toHaveLength(1)
    expect(pills[0]).toHaveTextContent('POP Singkawang')
  })

  it('tanpa cakupan & tanpa location_name -> null (strip pada DetailModal)', () => {
    const empty = userStub({
      role: 'security',
      nik: null,
      location_id: null,
      location_ids: undefined,
      location_name: null,
    })
    expect(fieldValue(securityUserDetailFields(empty, LOCATIONS), 'CABANG')).toBeNull()
  })

  it('tanpa cakupan tapi ada location_name -> tetap tampil sebagai teks', () => {
    const legacy = userStub({
      role: 'security',
      nik: null,
      location_id: null,
      location_ids: undefined,
      location_name: 'Cabang Malang',
    })
    expect(fieldValue(securityUserDetailFields(legacy, LOCATIONS), 'CABANG')).toBe('Cabang Malang')
  })
})
