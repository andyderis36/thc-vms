/**
 * Multi-branch admin: akun admin dengan coverage A+B dapat menyetujui kunjungan
 * di cabang A dan B, tetapi ditolak (403) untuk cabang C.
 *
 * Live-safe: akun admin temp dibuat via superadmin (@example.com? tidak — akun
 * internal memakai domain seed; email unik h.unique + cleanup DELETE di finally).
 * Kunjungan dibuat via harness (vendor temp tidak diperlukan; harness memakai
 * akun vendor seed) dengan approve:false, lalu disetujui oleh admin uji.
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

test('@MBR-01 admin multi-cabang menyetujui A dan B, 403 di C', async ({ h }) => {
  const trackedVisitIds: string[] = []
  const email = `${h.unique('mbradmin').toLowerCase()}@transhybrid.net.id`
  let userId = ''
  try {
    const superToken = (await loginViaApiCached(ACCOUNTS.super.email, ACCOUNTS.super.password)).token

    // Buat admin temp dengan coverage A+B.
    const created = await apiFetchRaw<ApiEnvelope<{ id: string }>>(superToken, 'POST', '/users', {
      name: `E2E MBR Admin ${h.unique('name')}`,
      email,
      password: 'Password123!',
      phone: '081200000001',
      nik: makeNik(),
      role: 'admin',
      location_id: LOCATIONS.hq,
      location_ids: [LOCATIONS.hq, LOCATIONS.sambas],
    })
    expect(created.status).toBe(201)
    userId = (created.body as { data: { id: string } }).data.id

    const adminToken = (await loginViaApi(email, 'Password123!')).token

    // Buat kunjungan (belum disetujui) di A, B, C.
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
        notes: `MBR ${locationId}`,
        visitors: [
          {
            name: 'MBR Anggota',
            id_number: `${String(now).slice(-13)}001`,
            phone: `0812${String(now).slice(-8)}`,
          },
        ],
      }
      if (catalog.purposeId !== null) {
        payload.purpose_ids = [catalog.purposeId]
      } else {
        payload.purpose_note = 'E2E MBR purpose'
      }
      const v = await createVisitViaApi(vendorToken, payload)
      trackedVisitIds.push(v.id)
      return v.id
    }

    const idA = await makeVisit(LOCATIONS.hq)
    const idB = await makeVisit(LOCATIONS.sambas)
    const idC = await makeVisit(LOCATIONS.mempawah)

    // Approve di A dan B harus sukses.
    const approveA = await apiFetchRaw(adminToken, 'POST', `/visits/${idA}/approve`, { notes: 'ok' })
    expect(approveA.status, `approve A -> ${approveA.status}`).toBeLessThan(300)
    const approveB = await apiFetchRaw(adminToken, 'POST', `/visits/${idB}/approve`, { notes: 'ok' })
    expect(approveB.status, `approve B -> ${approveB.status}`).toBeLessThan(300)

    // Approve di C harus 403.
    const approveC = await apiFetchRaw(adminToken, 'POST', `/visits/${idC}/approve`, { notes: 'ok' })
    expect(approveC.status, `approve C harus 403, dapat ${approveC.status}`).toBe(403)
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
