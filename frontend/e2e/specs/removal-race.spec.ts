/**
 * Removal-race: scope admin menyusut di tengah sesi — setelah coverage B
 * dicabut, kunjungan cabang B tidak lagi terlihat.
 *
 * Live-safe: akun admin temp + kunjungan temp, cleanup di finally.
 */

import { expect, test } from '../fixtures'
import {
  ACCOUNTS,
  LOCATIONS,
  apiFetchRaw,
  createVisitViaApi,
  deleteVisitViaApi,
  loginViaApi,
  loginViaApiCached,
  resolveLiveCatalog,
  uploadFileViaApi,
  type ApiEnvelope,
} from '../helpers/api'
import { pdfBuffer } from '../helpers/assets'

function makeNik(): string {
  const time = String(Date.now()).slice(-9).padStart(9, '0')
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
  return `9${time}${rand}`
}

test('@RR-01 scope admin menyusut mid-session menyembunyikan cabang B', async ({ h }) => {
  const trackedVisitIds: string[] = []
  const email = `${h.unique('rradmin').toLowerCase()}@transhybrid.net.id`
  let userId = ''
  try {
    const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token

    const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>(superToken, 'POST', '/users', {
      name: `E2E RR Admin ${h.unique('name')}`,
      email,
      password: 'Password123!',
      phone: '081200000002',
      nik: makeNik(),
      role: 'admin',
      location_id: LOCATIONS.hq,
      location_ids: [LOCATIONS.hq, LOCATIONS.sambas],
    })
    expect(created.status).toBe(201)
    userId = (created.body as { data: { id: string } }).data.id

    const adminToken = (await loginViaApi(email, 'Password123!')).token

    const vendorToken = (await loginViaApiCached(ACCOUNTS.vendor.email, ACCOUNTS.vendor.password)).token
    const catalog = await resolveLiveCatalog(vendorToken)

    async function makeVisit(locationId: string): Promise<string> {
      const spk = await uploadFileViaApi(vendorToken, 'assignment_letter', {
        name: `spk-${locationId}.pdf`,
        mimeType: 'application/pdf',
        buffer: pdfBuffer(8),
      })
      const now = Date.now()
      const payload: Record<string, unknown> = {
        location_id: locationId,
        start_date: new Date(now - 30 * 60_000).toISOString(),
        end_date: new Date(now + 180 * 60_000).toISOString(),
        is_nda_accepted: true,
        assignment_letter_url: spk.fileUrl,
        notes: `RR ${locationId}`,
        visitors: [
          {
            name: 'RR Anggota',
            id_number: `${String(now).slice(-13)}001`,
            phone: `0812${String(now).slice(-8)}`,
          },
        ],
      }
      if (catalog.purposeId !== null) {
        payload.purpose_ids = [catalog.purposeId]
      } else {
        payload.purpose_note = 'E2E RR purpose'
      }
      const v = await createVisitViaApi(vendorToken, payload)
      trackedVisitIds.push(v.id)
      return v.id
    }

    const hqId = await makeVisit(LOCATIONS.hq)
    const sambasId = await makeVisit(LOCATIONS.sambas)

    // Sebelum penyusutan: kedua kunjungan terlihat (limit besar supaya tidak
    // tergantung paginasi saat worker paralel lain ikut membuat kunjungan).
    const before = await apiFetchRaw<ApiEnvelope<{ items: Array<{ id: string }>; total: number }>>(
      adminToken,
      'GET',
      '/visits?limit=100',
    )
    expect(before.status).toBe(200)
    const beforeIds = (
      before.body as { data: { items: Array<{ id: string }> } }
    ).data.items.map((item) => item.id)
    expect(beforeIds, 'sebelum penyusutan: kunjungan HQ terlihat').toContain(hqId)
    expect(beforeIds, 'sebelum penyusutan: kunjungan Sambas terlihat').toContain(sambasId)

    // Cabut coverage B.
    const patch = await apiFetchRaw(superToken, 'PATCH', `/users/${userId}`, {
      location_ids: [LOCATIONS.hq],
    })
    expect(patch.status).toBeLessThan(300)

    // Setelah penyusutan: kunjungan B tidak lagi terlihat, HQ tetap terlihat.
    // Assertion per-ID (bukan perbandingan total) agar pembuatan/penghapusan
    // kunjungan oleh worker paralel lain tidak bisa meruntuhkannya.
    const after = await apiFetchRaw<ApiEnvelope<{ items: Array<{ id: string }>; total: number }>>(
      adminToken,
      'GET',
      '/visits?limit=100',
    )
    expect(after.status).toBe(200)
    const afterIds = (
      after.body as { data: { items: Array<{ id: string }> } }
    ).data.items.map((item) => item.id)
    expect(afterIds, 'setelah penyusutan: kunjungan HQ tetap terlihat').toContain(hqId)
    expect(afterIds, 'setelah penyusutan: kunjungan Sambas hilang').not.toContain(sambasId)

    // Detail langsung cabang B ditolak tanpa membocorkan keberadaan.
    const direct = await apiFetchRaw(adminToken, 'GET', `/visits/${sambasId}`)
    expect(
      [403, 404],
      'detail kunjungan di luar cakupan harus ditolak',
    ).toContain(direct.status)
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
