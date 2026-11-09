/**
 * Old-client scalar-compat: klien lama yang hanya mengirim `location_id` skalar
 * (tanpa `location_ids`) tetap berfungsi — akun dibuat dengan union = primary
 * tunggal, dan filter `?location_id=` skalar tetap diterima.
 *
 * Live-safe: akun admin temp + kunjungan temp, cleanup di finally.
 */

import { expect, test } from '../fixtures'
import {
  ACCOUNTS,
  LOCATIONS,
  apiFetchRaw,
  deleteVisitViaApi,
  loginViaApi,
  loginViaApiCached,
  type ApiEnvelope,
} from '../helpers/api'
import { pdfBuffer } from '../helpers/assets'
import { uploadFileViaApi, createVisitViaApi, resolveLiveCatalog } from '../helpers/api'

function makeNik(): string {
  const time = String(Date.now()).slice(-9).padStart(9, '0')
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
  return `9${time}${rand}`
}

test('@OSC-01 klien lama skalar location_id tetap kompatibel', async ({ h }) => {
  const trackedVisitIds: string[] = []
  const email = `${h.unique('oscadmin').toLowerCase()}@transhybrid.net.id`
  let userId = ''
  try {
    const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token

    // Buat admin dengan HANYA location_id skalar (tanpa location_ids).
    const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>(superToken, 'POST', '/users', {
      name: `E2E OSC Admin ${h.unique('name')}`,
      email,
      password: 'Password123!',
      phone: '081200000003',
      nik: makeNik(),
      role: 'admin',
      location_id: LOCATIONS.hq,
    })
    expect(created.status).toBe(201)
    userId = (created.body as { data: { id: string } }).data.id

    const adminToken = (await loginViaApi(email, 'Password123!')).token

    // Union fallback: akun skalar tanpa location_ids diproyeksikan sebagai [primary].
    const me = await apiFetchRaw<ApiEnvelope<{ location_id: string | null; location_ids: string[] }>>(adminToken, 'GET', '/auth/me')
    expect(me.status).toBe(200)
    if (!me.body.success) {
      throw new Error('GET /auth/me admin skalar gagal: ' + me.body.error.code)
    }
    expect(me.body.data.location_id).toBe(LOCATIONS.hq)
    expect(me.body.data.location_ids).toEqual([LOCATIONS.hq])

    // Kunjungan di HQ.
    const vendorToken = (await loginViaApiCached(ACCOUNTS.vendor.email, ACCOUNTS.vendor.password)).token
    const catalog = await resolveLiveCatalog(vendorToken)
    const spk = await uploadFileViaApi(vendorToken, 'assignment_letter', {
      name: 'spk-osc.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer(8),
    })
    const now = Date.now()
    const payload: Record<string, unknown> = {
      location_id: LOCATIONS.hq,
      start_date: new Date(now - 30 * 60_000).toISOString(),
      end_date: new Date(now + 180 * 60_000).toISOString(),
      is_nda_accepted: true,
      assignment_letter_url: spk.fileUrl,
      notes: 'OSC',
      visitors: [
        {
          name: 'OSC Anggota',
          id_number: `${String(now).slice(-13)}001`,
          phone: `0812${String(now).slice(-8)}`,
        },
      ],
    }
    if (catalog.purposeId !== null) {
      payload.purpose_ids = [catalog.purposeId]
    } else {
      payload.purpose_note = 'E2E OSC purpose'
    }
    const v = await createVisitViaApi(vendorToken, payload)
    trackedVisitIds.push(v.id)

    // Kunjungan di luar cakupan (Sambas) untuk probe isolasi.
    const outPayload: Record<string, unknown> = {
      location_id: LOCATIONS.sambas,
      start_date: new Date(now - 30 * 60_000).toISOString(),
      end_date: new Date(now + 180 * 60_000).toISOString(),
      is_nda_accepted: true,
      assignment_letter_url: spk.fileUrl,
      notes: 'OSC out-of-scope',
      visitors: [
        {
          name: 'OSC Out',
          id_number: String(now).slice(-13) + '002',
          phone: '0812' + String(now).slice(-8),
        },
      ],
    }
    if (catalog.purposeId !== null) {
      outPayload.purpose_ids = [catalog.purposeId]
    } else {
      outPayload.purpose_note = 'E2E OSC out-of-scope purpose'
    }
    const outVisit = await createVisitViaApi(vendorToken, outPayload)
    trackedVisitIds.push(outVisit.id)

    // Admin skalar dapat melihat kunjungan cabangnya.
    const list = await apiFetchRaw<ApiEnvelope<{ total: number }>>(adminToken, 'GET', '/visits')
    expect(list.status).toBe(200)

    // Superadmin filter skalar ?location_id= tetap diterima.
    const filtered = await apiFetchRaw<ApiEnvelope<{ total: number }>>(
      superToken,
      'GET',
      `/visits?location_id=${LOCATIONS.hq}`,
    )
    expect(filtered.status).toBe(200)

    // Probe luar cakupan: admin skalar HQ tidak boleh approve kunjungan Sambas (403).
    const denied = await apiFetchRaw(adminToken, 'POST', '/visits/' + outVisit.id + '/approve', { notes: 'ok' })
    expect(denied.status, 'approve luar cakupan harus 403, dapat ' + denied.status).toBe(403)
  } finally {
    if (trackedVisitIds.length > 0) {
      try {
        const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
        for (const vid of trackedVisitIds) {
          try {
            await deleteVisitViaApi(superToken, vid)
          } catch (e) {
            console.log(`[e2e-cleanup] delete visit ${vid}: ${String(e)}`)
          }
        }
      } catch (e) {
        console.log(`[e2e-cleanup] ${String(e)}`)
      }
    }
    if (userId !== '') {
      try {
        const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token
        await apiFetchRaw(superToken, 'DELETE', `/users/${userId}`)
      } catch (e) {
        console.log(`[e2e-cleanup] delete user ${userId}: ${String(e)}`)
      }
    }
  }
})
