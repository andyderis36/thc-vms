'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo } from 'react'

import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '@/lib/pagination'

export interface PaginationProps {
  /** Halaman aktif (1-based). */
  page: number
  /** Total halaman. */
  totalPages: number
  /** Callback saat halaman berubah. */
  onPageChange: (page: number) => void
  /** Nonaktifkan semua kontrol (prev/next/nomor). */
  disabled?: boolean
  /** Kelas Tailwind tambahan. */
  className?: string
  /** Tampilkan info "Halaman X dari Y". Default true. */
  showInfo?: boolean
  /** Label tombol prev. Default "Sebelumnya". */
  prevLabel?: string
  /** Label tombol next. Default "Berikutnya". */
  nextLabel?: string
  /** Jumlah baris per halaman (dikontrol pemanggil). Default DEFAULT_PAGE_SIZE. */
  pageSize?: number
  /** Callback saat ukuran halaman berubah. Terima angka, bukan string. Hanya render selektor saat disediakan. */
  onPageSizeChange?: (pageSize: number) => void
  /** Label nav untuk screen reader; default dipertahankan agar halaman kunjungan tidak berubah. */
  ariaLabel?: string
}

type PageItem = number | 'ellipsis'

/**
 * Maksimal jumlah NOMOR halaman yang ditampilkan sekaligus (windowing).
 * Sengaja kecil agar kontrol tetap ringkas: maksimal 5 tombol nomor + ellipsis,
 * bukan seluruh rentang (mis. `1 2 3 4 5 … 20`), sehingga baris kontrol tidak
 * melebar dan rapi di layar sempit.
 */
const WINDOW_SIZE = 5

/**
 * Hitung daftar item halaman dengan windowing + ellipsis.
 *
 * Kontrak bentuk keluaran (selalu ≤ WINDOW_SIZE nomor, ≤ 2 ellipsis,
 * halaman pertama & terakhir selalu hadir sebagai jangkar):
 * - `totalPages <= 0` → kosong.
 * - `totalPages <= WINDOW_SIZE` → seluruh nomor, tanpa ellipsis.
 * - dekat awal (`current <= 3`) → `[1, 2, 3, 4, …, total]`.
 * - dekat akhir (`current >= total - 2`) → `[1, …, total-3, total-2, total-1, total]`.
 * - di tengah → `[1, …, current-1, current, current+1, …, total]`.
 */
function getPageItems(currentPage: number, totalPages: number): PageItem[] {
  if (totalPages <= 0) {
    return []
  }
  if (totalPages <= WINDOW_SIZE) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  if (currentPage <= 3) {
    return [1, 2, 3, 4, 'ellipsis', totalPages]
  }
  if (currentPage >= totalPages - 2) {
    return [1, 'ellipsis', totalPages - 3, totalPages - 2, totalPages - 1, totalPages]
  }
  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages]
}

/**
 * `BUTTON_BASE` sengaja TIDAK membawa state tekan: ia hanya memuat
 * geometri + tipografi (tanpa fill sendiri), jadi tidak ada "permukaan"
 * yang bisa DiveGet lebih pekat. Setiap varian warna yang memiliki fill
 * sendiri membawa tekannya sendiri (lihat di bawah) — pola yang sama
 * dipakai `Button.tsx` (base = geometri, `VARIANT_CLASSES` = warna).
 *
 * Kontrak tekan (lihat blok aturan di `Button.tsx`): tekan = satu langkah
 * lebih pekat dari hover, hanya lewat background/warna/opacity; `active:`
 * mengalahkan `hover:` karena urutan varian CSS Tailwind v4.
 */
const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-control min-h-touch px-3 text-label font-semibold tracking-normal transition duration-150'
const PAGE_INACTIVE = `${BUTTON_BASE} cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 border border-brand text-brand hover:bg-brand-soft active:bg-brand/20`
const PAGE_ACTIVE = `${BUTTON_BASE} bg-brand text-brand-contrast hover:bg-brand-dark active:bg-brand-dark cursor-default`
const CONTROL = `${BUTTON_BASE} cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 border border-border-light text-ink-secondary hover:bg-neutral-bg hover:text-ink active:bg-ink/10`
const ELLIPSIS = 'text-xs font-semibold px-2 text-ink-muted'

export function Pagination({
  page = 1,
  totalPages = 1,
  onPageChange,
  disabled = false,
  className,
  showInfo = true,
  prevLabel = 'Sebelumnya',
  nextLabel = 'Berikutnya',
  pageSize,
  onPageSizeChange,
  ariaLabel = 'Paginasi kunjungan',
}: PaginationProps) {
  const currentPage = Math.max(1, Math.min(totalPages, page))
  const canPrev = currentPage > 1 && !disabled
  const canNext = currentPage < totalPages && !disabled

  const pageItems = useMemo(() => getPageItems(currentPage, totalPages), [currentPage, totalPages])

  const handlePage = (nextPage: number): void => {
    if (disabled || nextPage < 1 || nextPage > totalPages || nextPage === currentPage) return
    onPageChange(nextPage)
  }

  return (
    <nav aria-label={ariaLabel} className={className}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {showInfo && (
          <>
            <span className="text-sm text-ink-secondary tabular-nums">
              Halaman {currentPage} dari {totalPages}
            </span>
            {onPageSizeChange ? (
              <select
                aria-label="Baris per halaman"
                value={pageSize ?? DEFAULT_PAGE_SIZE}
                onChange={(e) => onPageSizeChange(Number(e.target.value))}
                disabled={disabled}
                className={`${CONTROL} min-h-touch`}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={String(n)}>
                    {n} / halaman
                  </option>
                ))}
              </select>
            ) : null}
          </>
        )}
        {/* Baris kontrol responsif (§6.5 AGENTS.md): di mobile nomor halaman
            mengambil satu baris penuh (`order-1 w-full`) dan tombol
            Sebelumnya/Berikutnya turun ke baris berikutnya (`order-3`/`order-4`);
            di ≥sm semuanya kembali sebaris (prev → nomor → next) lewat `sm:order-*`. */}
        <div className="flex w-full flex-wrap items-center justify-center gap-2 sm:w-auto sm:justify-end">
          <button
            type="button"
            className={`${CONTROL} order-3 sm:order-1`}
            disabled={!canPrev}
            onClick={() => handlePage(currentPage - 1)}
            aria-label="Halaman sebelumnya"
          >
            <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
            {prevLabel}
          </button>

          {/* Pembungkus nomor: satu blok penuh-lebar di mobile agar prev/next
              terdorong ke baris kedua; `sm:w-auto` mengembalikannya ke sebaris. */}
          <div className="order-1 flex w-full flex-wrap items-center justify-center gap-2 sm:order-2 sm:w-auto sm:justify-start">
            {pageItems.map((item, index) => {
              if (item === 'ellipsis') {
                // Kunci ellipsis wajib non-numerik: tombol nomor memakai `key={item}`
                // (mis. `4`), jadi `key={index}` bentrok dengan nomor halaman.
                return (
                  <span key={`ellipsis-${index}`} aria-hidden="true" className={ELLIPSIS}>
                    …
                  </span>
                )
              }
              const isActive = item === currentPage
              return (
                <button
                  key={item}
                  type="button"
                  className={isActive ? PAGE_ACTIVE : PAGE_INACTIVE}
                  disabled={disabled || isActive}
                  onClick={() => handlePage(item)}
                  aria-label={`Halaman ${item}`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {item}
                </button>
              )
            })}
          </div>

          <button
            type="button"
            className={`${CONTROL} order-4 sm:order-3`}
            disabled={!canNext}
            onClick={() => handlePage(currentPage + 1)}
            aria-label="Halaman berikutnya"
          >
            {nextLabel}
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>
    </nav>
  )
}
