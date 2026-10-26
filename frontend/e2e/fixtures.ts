/**
 * Fixture harness E2E THC VMS.
 *
 * Setiap test mendapat satu `h` yang menyediakan helper per-peran:
 * - `tokenAs` / `apiAs` / `openAs` untuk berinteraksi lewat API atau browser
 *   sebagai akun seed mana pun (token JWT di localStorage, bukan cookie).
 * - `createVisit` membuat kunjungan NYATA lewat API dengan suffix unik agar
 *   mudah dicari di UI tanpa bertabrakan dengan data lain.
 *
 * Semua kunjungan yang dibuat dicatat dan dihapus di teardown memakai token
 * `super` (super_admin boleh menghapus lintas cabang). Objek MinIO hasil
 * unggahan ikut dihapus; kegagalan cleanup menggagalkan test.
 */

import { test as base, expect } from '@playwright/test'
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import {
  ACCOUNTS,
  API_BASE,
  FRONTEND_BASE,
  LOCATIONS,
  PURPOSES,
  TOKEN_STORAGE_KEY,
  apiFetchRaw,
  approveVisitViaApi,
  createVisitViaApi,
  deleteVisitViaApi,
  getVisitViaApi,
  loginViaApiCached,
  uploadFileViaApi,
  type Role,
} from './helpers/api'
import { jpegBuffer, pdfBuffer, pngBuffer } from './helpers/assets'
import { deleteUploadedFiles } from './helpers/storage'

/** Purpose default untuk kunjungan buatan harness. */
const DEFAULT_PURPOSE_ID = PURPOSES['Splicing & Maintenance Kabel Fiber Optik']

/**
 * Surat Tugas pengganti saat `withFiles:false`. Backend mewajibkan
 * `assignment_letter_url` untuk setiap pengajuan baru, tetapi hanya
 * memvalidasi bentuk URL (http dev host diizinkan), bukan keberadaan objek.
 */
const PLACEHOLDER_SPK_URL =
  'http://localhost:9000/thc-vms-bucket/assignment_letter/e2e-placeholder.pdf'

export interface CreateVisitOptions {
  role?: Role
  locationId?: string
  purposeIds?: string[]
  /** Menit relatif terhadap sekarang; default -30 (jadwal sudah mulai). */
  startOffsetMinutes?: number
  /** Menit relatif terhadap sekarang; default 180. */
  endOffsetMinutes?: number
  memberCount?: number
  /** Default true: disetujui admin cabang yang cocok (atau super untuk cabang lain). */
  approve?: boolean
  /** Default true: unggah KTP + selfie + SPK nyata lewat API. */
  withFiles?: boolean
  notes?: string
}

export interface OpenAsOptions {
  /** Dijalankan sebelum dokumen mana pun dimuat (mis. menolak akses kamera). */
  initScript?: () => void
}

export interface Harness {
  unique(label: string): string
  tokenAs(role: Role): Promise<string>
  apiAs(role: Role): Promise<APIRequestContext>
  openAs(role: Role, options?: OpenAsOptions): Promise<Page>
  createVisit(
    label: string,
    opts?: CreateVisitOptions,
  ): Promise<{ id: string; code: string; status: string; locationId: string }>
}

/** Pilih admin yang cabangnya cocok; super_admin untuk selain HQ/Sambas. */
function approverFor(locationId: string): Role {
  if (locationId === LOCATIONS.hq) return 'admin'
  if (locationId === LOCATIONS.sambas) return 'admin-sambas'
  return 'super'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const test = base.extend<{ h: Harness }>({
  h: async ({ playwright, browser }, use) => {
    const tokenCache = new Map<Role, string>()
    const apiContexts: APIRequestContext[] = []
    const browserContexts: BrowserContext[] = []
    const createdVisitIds: string[] = []
    const uploadedFileUrls: string[] = []
    let sequence = 0

    const tokenAs = async (role: Role): Promise<string> => {
      const cached = tokenCache.get(role)
      if (cached !== undefined) {
        return cached
      }
      const account = ACCOUNTS[role]
      const { token } = await loginViaApiCached(account.email, account.password)
      tokenCache.set(role, token)
      return token
    }

    const harness: Harness = {
      unique(label: string): string {
        sequence += 1
        const random = Math.random().toString(36).slice(2, 8)
        return `E2E-${label}-${Date.now()}-${sequence}-${random}`
      },

      tokenAs,

      async apiAs(role: Role): Promise<APIRequestContext> {
        const token = await tokenAs(role)
        const context = await playwright.request.newContext({
          baseURL: API_BASE,
          extraHTTPHeaders: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
          },
        })
        apiContexts.push(context)
        return context
      },

      async openAs(role: Role, options: OpenAsOptions = {}): Promise<Page> {
        const token = await tokenAs(role)
        const context = await browser.newContext({
          baseURL: FRONTEND_BASE,
          storageState: {
            cookies: [],
            origins: [
              {
                origin: FRONTEND_BASE,
                localStorage: [{ name: TOKEN_STORAGE_KEY, value: token }],
              },
            ],
          },
        })
        if (options.initScript !== undefined) {
          await context.addInitScript(options.initScript)
        }
        browserContexts.push(context)
        return context.newPage()
      },

      async createVisit(label, opts = {}) {
        if (DEFAULT_PURPOSE_ID === undefined) {
          throw new Error('[harness] purpose default tidak ditemukan di seed map.')
        }

        const role = opts.role ?? 'vendor'
        const locationId = opts.locationId ?? LOCATIONS.hq
        const startOffsetMinutes = opts.startOffsetMinutes ?? -30
        const endOffsetMinutes = opts.endOffsetMinutes ?? 180
        const memberCount = Math.min(10, Math.max(1, Math.trunc(opts.memberCount ?? 1)))
        const purposeIds = opts.purposeIds ?? [DEFAULT_PURPOSE_ID]
        const withFiles = opts.withFiles !== false
        const approve = opts.approve !== false
        const marker = harness.unique(label)
        const token = await tokenAs(role)

        let assignmentLetterUrl = PLACEHOLDER_SPK_URL
        let idCardPhotoUrl: string | undefined
        let selfieUrl: string | undefined
        if (withFiles) {
          const spk = await uploadFileViaApi(token, 'assignment_letter', {
            name: `spk-${marker}.pdf`,
            mimeType: 'application/pdf',
            buffer: pdfBuffer(8),
          })
          uploadedFileUrls.push(spk.fileUrl)
          const ktp = await uploadFileViaApi(token, 'id_card', {
            name: `ktp-${marker}.jpg`,
            mimeType: 'image/jpeg',
            buffer: jpegBuffer(),
          })
          uploadedFileUrls.push(ktp.fileUrl)
          const selfie = await uploadFileViaApi(token, 'id_card', {
            name: `selfie-${marker}.png`,
            mimeType: 'image/png',
            buffer: pngBuffer(),
          })
          uploadedFileUrls.push(selfie.fileUrl)
          assignmentLetterUrl = spk.fileUrl
          idCardPhotoUrl = ktp.fileUrl
          selfieUrl = selfie.fileUrl
        }

        const now = Date.now()
        const visitors = Array.from({ length: memberCount }, (_, index) => {
          const visitor: Record<string, unknown> = {
            name: `${marker} Visitor ${index + 1}`,
            id_number: `${String(now).slice(-13)}${String(index + 1).padStart(3, '0')}`,
            phone: `0812${String(now + index).slice(-8)}`,
            vendor_name: 'PT Lintas Fiber',
            jabatan: 'Teknisi',
          }
          if (index === 0 && idCardPhotoUrl !== undefined) {
            visitor.id_card_photo_url = idCardPhotoUrl
          }
          if (index === 0 && selfieUrl !== undefined) {
            visitor.photo_url = selfieUrl
          }
          return visitor
        })

        const notes = [opts.notes, marker].filter((part): part is string => !!part).join(' | ')

        const created = await createVisitViaApi(token, {
          location_id: locationId,
          purpose_ids: purposeIds,
          start_date: new Date(now + startOffsetMinutes * 60_000).toISOString(),
          end_date: new Date(now + endOffsetMinutes * 60_000).toISOString(),
          is_nda_accepted: true,
          assignment_letter_url: assignmentLetterUrl,
          notes,
          visitors,
        })
        createdVisitIds.push(created.id)

        if (created.visit_id === undefined) {
          throw new Error(`[harness] createVisit ${marker}: respons tidak memuat visit_id.`)
        }
        console.log(
          `[e2e-harness] createVisit ${marker} -> ${created.visit_id} (${created.id}) status=${created.status}`,
        )

        if (!approve) {
          return {
            id: created.id,
            code: created.visit_id,
            status: created.status,
            locationId: created.location_id ?? locationId,
          }
        }

        const approver = approverFor(locationId)
        const approverToken = await tokenAs(approver)
        await approveVisitViaApi(
          approverToken,
          created.id,
          `Disetujui harness E2E (${approver}) untuk ${marker}.`,
        )
        const finalVisit = await getVisitViaApi(await tokenAs('super'), created.id)
        return {
          id: finalVisit.id,
          code: finalVisit.visit_id ?? created.visit_id,
          status: finalVisit.status,
          locationId: finalVisit.location_id ?? locationId,
        }
      },
    }

    await use(harness)

    // ---- Teardown -------------------------------------------------------
    // Hapus kunjungan uji memakai super_admin; 404/409 diabaikan.
    if (createdVisitIds.length > 0) {
      try {
        const superToken = await tokenAs('super')
        for (const visitId of createdVisitIds) {
          try {
            await deleteVisitViaApi(superToken, visitId)
            console.log(`[e2e-cleanup] DELETE ${visitId} -> 204 (dihapus)`)
          } catch (error) {
            console.log(`[e2e-cleanup] DELETE ${visitId} dilewati: ${errorMessage(error)}`)
          }
          try {
            const verify = await apiFetchRaw(superToken, 'GET', `/visits/${visitId}`)
            console.log(
              `[e2e-cleanup] verify GET ${visitId} -> HTTP ${verify.status} (harus 404 = bersih)`,
            )
          } catch (error) {
            console.log(`[e2e-cleanup] verify GET ${visitId} gagal: ${errorMessage(error)}`)
          }
        }
      } catch (error) {
        console.log(`[e2e-cleanup] cleanup kunjungan dilewati: ${errorMessage(error)}`)
      }
    }

    // Tutup seluruh context/page; tidak boleh ada context bocor.
    await Promise.all(
      browserContexts.map(async (context) => {
        try {
          await context.close()
        } catch (error) {
          console.log(`[e2e-cleanup] gagal menutup browser context: ${errorMessage(error)}`)
        }
      }),
    )
    await Promise.all(
      apiContexts.map(async (context) => {
        try {
          await context.dispose()
        } catch (error) {
          console.log(`[e2e-cleanup] gagal dispose API context: ${errorMessage(error)}`)
        }
      }),
    )

    // Objek bucket prod tidak terjangkau dari luar VPS (MinIO internal), jadi
    // cleanup dilewati saat E2E_SKIP_STORAGE_CLEANUP=1 dan residu dicatat.
    if (uploadedFileUrls.length > 0) {
      if (process.env.E2E_SKIP_STORAGE_CLEANUP === '1') {
        console.log(
          `[e2e-cleanup] cleanup bucket dilewati; ${uploadedFileUrls.length} objek tersisa di target`,
        )
      } else {
        await deleteUploadedFiles(uploadedFileUrls)
      }
    }
  },
})

export { expect }
