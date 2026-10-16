// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { VisitorPhoto } from './VisitorPhoto'

/**
 * Kontrak migrasi `<img>` → `next/image` (tugas S5/S3):
 *
 * - Thumbnail & pratinjau modal WAJIB dirender `next/image` (terdeteksi lewat
 *   atribut `data-nimg`) dengan `sizes` eksplisit dan `loading="lazy"`.
 * - `src` asli (URL presigned MinIO dev `http://localhost:9000/...`) harus
 *   tetap terbawa utuh di dalam URL optimasi `/_next/image?url=...`.
 * - `src` null / kosong → fallback kotak netral Bahasa Indonesia TANPA elemen
 *   `<img>` (bukan gambar rusak).
 */
const PRESIGNED_URL =
  'http://localhost:9000/thc-vms-bucket/selfies/visit-1/budi.jpg' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=minioadmin&X-Amz-Signature=abc123'

/** `src` next/image dibungkus `/_next/image?url=<urlencode>` — bandingkan setelah decode. */
function decodedSrc(img: HTMLElement): string {
  return decodeURIComponent(img.getAttribute('src') ?? '')
}

describe('VisitorPhoto — next/image', () => {
  it('merender thumbnail selfie sebagai next/image dengan src, sizes, alt, dan lazy yang benar', () => {
    render(<VisitorPhoto src={PRESIGNED_URL} visitorName="Budi Santoso" variant="selfie" />)

    const img = screen.getByRole('img', { name: 'Foto selfie Budi Santoso' })
    expect(img).toHaveAttribute('data-nimg')
    expect(img.getAttribute('sizes')).toBe('56px')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('alt', 'Foto selfie Budi Santoso')
    expect(decodedSrc(img)).toContain(PRESIGNED_URL)
    expect(img).toHaveClass('size-14')
  })

  it('merender thumbnail KTP sebagai next/image dengan ukuran kotak 80×56 yang sama', () => {
    render(<VisitorPhoto src={PRESIGNED_URL} visitorName="Ani Wijaya" variant="ktp" />)

    const img = screen.getByRole('img', { name: 'Foto KTP Ani Wijaya' })
    expect(img).toHaveAttribute('data-nimg')
    expect(img.getAttribute('sizes')).toBe('80px')
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(decodedSrc(img)).toContain(PRESIGNED_URL)
    expect(img).toHaveClass('h-14', 'w-20')
  })

  it('pratinjau di dalam modal juga dirender next/image dengan sizes dan lazy', () => {
    render(<VisitorPhoto src={PRESIGNED_URL} visitorName="Budi Santoso" variant="selfie" />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Lihat foto Foto selfie Budi Santoso lebih besar' }),
    )

    const dialog = screen.getByRole('dialog')
    const preview = within(dialog).getByRole('img', { name: 'Foto selfie Budi Santoso' })
    expect(preview).toHaveAttribute('data-nimg')
    expect(preview.getAttribute('sizes')).toBe(
      '(max-width: 544px) calc(100vw - 80px), 464px',
    )
    expect(preview).toHaveAttribute('loading', 'lazy')
    expect(decodedSrc(preview)).toContain(PRESIGNED_URL)
    expect(preview).toHaveClass('object-contain')
  })
})

describe('VisitorPhoto — fallback Indonesia', () => {
  it('src null menampilkan kotak netral berlabel Indonesia tanpa elemen <img>', () => {
    const { container } = render(
      <VisitorPhoto src={null} visitorName="Budi Santoso" variant="selfie" />,
    )

    expect(
      screen.getByRole('img', { name: 'Foto selfie Budi Santoso tidak tersedia' }),
    ).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container).not.toHaveTextContent('tidak dapat dimuat')
  })

  it('src kosong / hanya spasi diperlakukan sama seperti tidak ada berkas', () => {
    const { container } = render(
      <VisitorPhoto src={'   '} visitorName="Ani Wijaya" variant="ktp" />,
    )

    expect(
      screen.getByRole('img', { name: 'Foto KTP Ani Wijaya tidak tersedia' }),
    ).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  it('gagal memuat (onError) mengganti gambar dengan ikon + caption Bahasa Indonesia', () => {
    render(<VisitorPhoto src={PRESIGNED_URL} visitorName="Budi Santoso" variant="selfie" />)

    const img = screen.getByRole('img', { name: 'Foto selfie Budi Santoso' })
    fireEvent.error(img)

    expect(
      screen.getByRole('img', { name: 'Foto selfie Budi Santoso tidak dapat dimuat' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Foto selfie Budi Santoso' })).toBeNull()
    expect(screen.getByText('Foto selfie tidak dapat dimuat')).toBeInTheDocument()
  })
})
