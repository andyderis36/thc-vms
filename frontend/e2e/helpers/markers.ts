/**
 * Penanda bersama artefak E2E (single source of truth).
 *
 * Diimpor oleh `e2e/sweep.ts` (penghapus artefak pra/post-suite) dan
 * `e2e/global.setup.ts` (pembersih kunjungan sisa) supaya definisi penanda
 * tidak pernah drift: ubah di sini, kedua pemakai ikut berubah.
 *
 * Modul ini MURNI (tanpa I/O, tanpa baca env saat load) agar aman diimpor
 * dua cara: statis oleh Playwright (`global.setup.ts`) dan dinamis via URL
 * oleh `node` langsung (`sweep.ts`, pola yang sama dengan `helpers/api.ts`).
 * Hanya sintaks type-strippable (tanpa enum/namespace/dekorator).
 */

/**
 * Bentuk ketat marker harness `h.unique`: `E2E-<label>-<epoch>-<seq>-<rand>`.
 * Harness selalu menulis marker ini ke kolom `notes` setiap kunjungan
 * (termasuk varian `purpose_note` — lihat `fixtures.ts`), sehingga sapuan
 * yang mencocokkan pola ini tepat mengenai artefak harness dan bukan
 * catatan produksi yang kebetulan mengandung `E2E-`.
 */
export const HARNESS_NOTE_MARKER = /E2E-[A-Za-z0-9]+-\d+-\d+-[a-z0-9]+/

/**
 * Bentuk email PERSIS yang dibuat provisioner (`buildEmails` di
 * `provision-live-users.ts`): `e2e-<runid>-<role>@<domain>` dengan peran
 * harness eksplisit (admin/admin2/security/security2/vendor/vendor2).
 *
 * SENGAJA tanpa alternatif prefix bertitik (`foo.e2e-...@...`): provisioner
 * tidak pernah membuat email seperti itu, dan alternatif longgar berisiko
 * cocok dengan akun produksi yang tidak terkait (live-safety).
 */
export function buildUserMarker(domains: Iterable<string>): RegExp {
  const list = [...domains].map((d) => d.replace(/\./g, '\\.')).join('|')
  return new RegExp(
    `^e2e-[a-z0-9][a-z0-9-]*-(?:admin2|security2|vendor2|admin|security|vendor)@(?:${list})$`,
    'i',
  )
}

/** `true` bila teks catatan mengandung marker harness yang ketat. */
export function isHarnessNote(notes: string): boolean {
  return HARNESS_NOTE_MARKER.test(notes)
}

/**
 * Akun temp spek email (`notification-email.spec.ts`): `andyderispas33+e2e-…`
 * `@gmail.com`. Bentuk EKSAK — alamat operator tanpa infix `+e2e-` tidak
 * pernah cocok, jadi akun produksi tak tersentuh. Menutup lubang orphan saat
 * test timeout membunuh worker sebelum `finally` teardown tuntas.
 */
export function isNemTempEmail(email: string): boolean {
  return /^andyderispas33\+e2e-[a-z0-9-]+@gmail\.com$/i.test(email.trim())
}
