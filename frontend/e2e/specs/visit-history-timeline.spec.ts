/**
 * SCR-04 — Panel "Riwayat Status" (`/visits/{id}`) bersifat append-only.
 *
 * Yang dibuktikan: tidak ada node timeline yang HILANG saat kunjungan bergerak
 * maju lewat state machine (`backend/internal/domain/status.go`, 16 transisi
 * legal). Setiap skenario membuat kunjungan via harness `h.createVisit`
 * (auto-cleanup teardown super_admin: DELETE -> verify GET 404), menjalankan
 * transisi berat lewat API harness agar stabil, lalu membuka halaman detail
 * sebagai vendor pemilik dan mengassert panel di browser.
 *
 * Teks UI nyata dari kode (`features/visits/detail/Timeline.tsx`,
 * `lib/visits/status-badge.ts`):
 * - Langkah turunan: "Pengajuan" + "Diajukan <stempel>", "Persetujuan" +
 *   "Menunggu persetujuan" / "Disetujui oleh admin", "Kedatangan di Lokasi" +
 *   "Jadwal mulai …", "Selesai" + "Jadwal selesai …".
 * - Baris riwayat berpelaku: label Indonesia ("Disetujui", "Ditolak",
 *   "Dibatalkan", "Jadwal Digeser", "Sedang di Lokasi",
 *   "Check-out — di luar lokasi", "Selesai") + detail
 *   "oleh <nama> (<peran>) · <stempel>".
 * - Status terminal Timeline (`rejected`, `cancelled`, `not_visit`): hanya
 *   Pengajuan + baris riwayat, ditutup baris "Status akhir" + badge.
 *   (`completed` BUKAN terminal di Timeline: ia menutup tahap Selesai.)
 * - Backend hanya mencatat `status_history` saat transisi, bukan saat
 *   pembuatan — jadi riwayat produksi tak pernah berisi `requested`; panel
 *   menambal baris "Pengajuan" sintetis agar append-only. Inilah inti yang
 *   diuji H2–H6: "Pengajuan"/"Diajukan" tetap ada setelah transisi pertama.
 *
 * Di luar cakupan (SENGAJA tidak diulang, sudah dikunci spec lain):
 * - `@CANCEL-*` / `@QREP-*` (`visit-lifecycle.spec.ts`): tombol batal, gerbang
 *   QR, payload `visit_id`, penolakan peran, `visiting -> cancelled` ilegal.
 * - `@GATE-*` (`gate-scanner.spec.ts`): toleransi ±2 jam, isolasi cabang gate.
 * - `@APPR-*` (`approvals.spec.ts`): modal ubah jadwal + approve ulang di UI.
 *
 * Tanpa `waitForTimeout`/sleep: sinkronisasi memakai `expect(...).toBeVisible()`.
 */

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  approveVisitViaApi,
  cancelVisitViaApi,
  checkInViaApi,
  checkOutViaApi,
  rejectVisitViaApi,
  rescheduleVisitViaApi,
} from '../helpers/api'
import { gotoApp } from '../helpers/nav'

/** Buka `/visits/{id}` lalu tunggu heading kode kunjungan (guard sesi lolos). */
async function openDetail(page: Page, visitId: string, code: string): Promise<void> {
  await gotoApp(page, `/visits/${visitId}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code)
  await expect(page.getByText('Riwayat Status', { exact: true })).toBeVisible()
}

/** Inti append-only: simpul Pengajuan tak pernah hilang apapun statusnya. */
async function expectPengajuanIntact(page: Page): Promise<void> {
  await expect(page.getByText('Pengajuan', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/^Diajukan /).first()).toBeVisible()
}

test('@HIST-01 requested: Pengajuan + Diajukan + Persetujuan/Menunggu + jadwal Kedatangan/Selesai', async ({
  h,
}) => {
  const visit = await h.createVisit('hist01', { approve: false, withFiles: false })
  expect(visit.status).toBe('requested')

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)

  await expectPengajuanIntact(page)
  await expect(page.getByText('Persetujuan', { exact: true })).toBeVisible()
  await expect(page.getByText('Menunggu persetujuan', { exact: true })).toBeVisible()
  await expect(page.getByText('Kedatangan di Lokasi', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Jadwal mulai /).first()).toBeVisible()
  await expect(page.getByText('Selesai', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/^Jadwal selesai /).first()).toBeVisible()
})

test('@HIST-02 approved: Pengajuan + Diajukan tetap ada + Disetujui berpelaku + tahap jadwal Kedatangan/Selesai', async ({
  h,
}) => {
  const visit = await h.createVisit('hist02', { withFiles: false })
  expect(visit.status).toBe('approved')

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)

  // Append-only: simpul Pengajuan sintetis tetap dirender meski riwayat
  // backend kini berisi [approved] (tanpa `requested`).
  await expectPengajuanIntact(page)
  // Baris riwayat berpelaku: label + klause "oleh".
  await expect(page.getByText('Disetujui', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/oleh .*·/).first()).toBeVisible()
  // Tahap masa depan masih dirender sebagai langkah jadwal.
  await expect(page.getByText('Kedatangan di Lokasi', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Jadwal mulai /).first()).toBeVisible()
  await expect(page.getByText(/^Jadwal selesai /).first()).toBeVisible()
})

test('@HIST-03 rejected: Pengajuan + Status akhir + badge Ditolak', async ({ h }) => {
  const visit = await h.createVisit('hist03', { approve: false, withFiles: false })
  await rejectVisitViaApi(
    await h.tokenAs('admin'),
    visit.id,
    'E2E HIST-03: fasilitas penuh pada jadwal ini.',
  )

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)

  await expectPengajuanIntact(page)
  await expect(page.getByText('Ditolak', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Status akhir', { exact: true })).toBeVisible()
})

test('@HIST-04 cancelled setelah approved: Pengajuan + Disetujui + Status akhir Dibatalkan', async ({
  h,
}) => {
  // `approved -> cancelled` legal (requested/approved/rescheduled boleh
  // dibatalkan; yang ilegal hanya `visiting -> cancelled`, dikunci @CANCEL-04).
  const visit = await h.createVisit('hist04', { withFiles: false })
  await cancelVisitViaApi(await h.tokenAs('vendor'), visit.id, 'E2E HIST-04: batal pelanggan.')

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)

  await expectPengajuanIntact(page)
  await expect(page.getByText('Disetujui', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Dibatalkan', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Status akhir', { exact: true })).toBeVisible()
})

test('@HIST-05 reschedule lalu approved ulang: Pengajuan + Jadwal Digeser + Disetujui, tak ada node hilang', async ({
  h,
}) => {
  // Rantai legal: approved -> rescheduled -> approved (reschedule wajib
  // disetujui ulang sebelum gate; `rescheduled -> visiting` dilarang diagram).
  const visit = await h.createVisit('hist05', { withFiles: false })
  const vendorToken = await h.tokenAs('vendor')
  const start = new Date(Date.now() + 24 * 60 * 60_000)
  const end = new Date(Date.now() + 24 * 60 * 60_000 + 120 * 60_000)
  await rescheduleVisitViaApi(vendorToken, visit.id, start.toISOString(), end.toISOString())
  await approveVisitViaApi(
    await h.tokenAs('admin'),
    visit.id,
    'E2E HIST-05: setujui ulang setelah geser jadwal.',
  )

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)

  await expectPengajuanIntact(page)
  await expect(page.getByText('Jadwal Digeser', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Disetujui', { exact: true }).first()).toBeVisible()
  // Tahap masa depan tetap ada setelah dua transisi.
  await expect(page.getByText('Kedatangan di Lokasi', { exact: true })).toBeVisible()
})

test('@HIST-06 visiting lalu offsite: Pengajuan + Disetujui + Sedang di Lokasi + Check-out di luar lokasi', async ({
  h,
}) => {
  // Rantai legal: approved -> visiting (check-in) -> offsite (check-out).
  // Check-out multi-entry TIDAK completed: permit tetap aktif di luar lokasi,
  // siap re-entry dengan QR yang sama; completed hanya via aksi Selesaikan
  // manual atau worker R3 di akhir jadwal. Jadwal default harness (mulai
  // -30 mnt, selesai +180 mnt) berada di dalam jendela toleransi check-in
  // ±2 jam (AGENTS.md 6.2), jadi gate API lolos.
  // `not_visit` SENGAJA tidak ditempuh di sini: ia hanya ditulis worker
  // auto-rule saat jendela lewat +2 jam tanpa check-in — mustahil dibuat
  // deterministik tanpa menunggu waktu nyata.
  const visit = await h.createVisit('hist06', { withFiles: false })
  const securityToken = await h.tokenAs('security')
  await checkInViaApi(securityToken, visit.id)
  await checkOutViaApi(securityToken, visit.id)

  const page = await h.openAs('vendor')
  await openDetail(page, visit.id, visit.code)

  await expectPengajuanIntact(page)
  await expect(page.getByText('Disetujui', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Sedang di Lokasi', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Check-out — di luar lokasi', { exact: true }).first()).toBeVisible()
  // Offsite bukan terminal: tidak ada baris "Status akhir", dan tahap Selesai
  // tetap dirender sebagai langkah masa depan (jadwal selesai).
  await expect(page.getByText('Status akhir', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Selesai', { exact: true }).first()).toBeVisible()
})
