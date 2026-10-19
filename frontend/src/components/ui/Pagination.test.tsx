// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Pagination, type PaginationProps } from './Pagination'

function renderPagination(overrides: Partial<PaginationProps> = {}) {
  const onPageChange = vi.fn()
  const props: PaginationProps = {
    page: 1,
    totalPages: 10,
    onPageChange,
    ...overrides,
  }
  render(<Pagination {...props} />)
  return { onPageChange }
}

/** Teks tombol nomor halaman dalam urutan DOM (tanpa prev/next). */
function numberLabels(): string[] {
  return screen
    .getAllByRole('button', { name: /^Halaman \d+$/ })
    .map((button) => button.textContent ?? '')
}

describe('Pagination', () => {
  it('merender tombol prev/next, nomor halaman, ellipsis, dan info "Halaman X dari Y"', () => {
    renderPagination({ page: 3, totalPages: 10 })

    expect(screen.getByText('Halaman 3 dari 10')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Halaman sebelumnya/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Halaman berikutnya/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Halaman 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Halaman 3' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Halaman 10' })).toBeInTheDocument()
    expect(screen.getByText('…')).toBeInTheDocument()
  })

  it('memanggil onPageChange saat nomor halaman diklik', () => {
    const { onPageChange } = renderPagination({ page: 1, totalPages: 5 })

    fireEvent.click(screen.getByRole('button', { name: 'Halaman 4' }))

    expect(onPageChange).toHaveBeenCalledTimes(1)
    expect(onPageChange).toHaveBeenCalledWith(4)
  })

  it('memanggil onPageChange saat tombol prev/next diklik', () => {
    const { onPageChange } = renderPagination({ page: 3, totalPages: 10 })

    fireEvent.click(screen.getByRole('button', { name: /Halaman sebelumnya/ }))
    expect(onPageChange).toHaveBeenCalledWith(2)

    fireEvent.click(screen.getByRole('button', { name: /Halaman berikutnya/ }))
    expect(onPageChange).toHaveBeenCalledWith(4)
  })

  it('menonaktifkan tombol prev di halaman pertama', () => {
    const { onPageChange } = renderPagination({ page: 1, totalPages: 5 })

    const prev = screen.getByRole('button', { name: /Halaman sebelumnya/ })
    const next = screen.getByRole('button', { name: /Halaman berikutnya/ })

    expect(prev).toBeDisabled()
    expect(next).not.toBeDisabled()

    fireEvent.click(next)
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('menonaktifkan tombol next di halaman terakhir', () => {
    renderPagination({ page: 5, totalPages: 5 })

    expect(screen.getByRole('button', { name: /Halaman sebelumnya/ })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /Halaman berikutnya/ })).toBeDisabled()
  })

  it('menampilkan ellipsis saat totalPages melebihi window', () => {
    renderPagination({ page: 4, totalPages: 10 })

    expect(screen.getAllByText('…')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Halaman 2' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Halaman 9' })).not.toBeInTheDocument()
  })

  it('tidak menampilkan ellipsis saat totalPages <= 5 (seluruh nomor muat)', () => {
    renderPagination({ page: 3, totalPages: 5 })

    expect(screen.queryByText('…')).not.toBeInTheDocument()
    expect(numberLabels()).toEqual(['1', '2', '3', '4', '5'])
    expect(screen.getByRole('button', { name: 'Halaman 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Halaman 5' })).toBeInTheDocument()
  })

  it('menampilkan ellipsis saat totalPages sedikit di atas window (6–7)', () => {
    renderPagination({ page: 3, totalPages: 7 })

    expect(screen.getAllByText('…')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Halaman 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Halaman 7' })).toBeInTheDocument()
  })

  it('tidak memicu peringatan duplicate key saat ellipsis sejajar nomor halaman', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    renderPagination({ page: 1, totalPages: 7 })

    const duplicateKeyWarning = errorSpy.mock.calls.find((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('same key')),
    )
    expect(duplicateKeyWarning).toBeUndefined()

    errorSpy.mockRestore()
  })

  it('membatasi jendela nomor di dekat awal: 1 2 3 4 … total', () => {
    renderPagination({ page: 2, totalPages: 20 })

    expect(numberLabels()).toEqual(['1', '2', '3', '4', '20'])
    expect(screen.getAllByText('…')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Halaman 5' })).not.toBeInTheDocument()
  })

  it('membatasi jendela nomor di tengah: 1 … c-1 c c+1 … total', () => {
    renderPagination({ page: 10, totalPages: 20 })

    expect(numberLabels()).toEqual(['1', '9', '10', '11', '20'])
    expect(screen.getAllByText('…')).toHaveLength(2)
  })

  it('membatasi jendela nomor di dekat akhir: 1 … total-3 total-2 total-1 total', () => {
    renderPagination({ page: 19, totalPages: 20 })

    expect(numberLabels()).toEqual(['1', '17', '18', '19', '20'])
    expect(screen.getAllByText('…')).toHaveLength(1)
  })

  it('menata nomor penuh-lebar lalu menurunkan prev/next ke baris berikutnya di mobile', () => {
    renderPagination({ page: 10, totalPages: 20 })

    const prev = screen.getByRole('button', { name: /Halaman sebelumnya/ })
    const next = screen.getByRole('button', { name: /Halaman berikutnya/ })
    const numbersWrapper = screen.getByRole('button', { name: 'Halaman 10' }).parentElement

    expect(prev).toHaveClass('order-3', 'sm:order-1')
    expect(next).toHaveClass('order-4', 'sm:order-3')
    expect(numbersWrapper).toHaveClass('order-1', 'w-full', 'sm:order-2', 'sm:w-auto')
  })

  it('menandai halaman aktif dengan aria-current="page" dan tombol disabled', () => {
    renderPagination({ page: 3, totalPages: 10 })

    const active = screen.getByRole('button', { name: 'Halaman 3' })
    expect(active).toHaveAttribute('aria-current', 'page')
    expect(active).toBeDisabled()
  })

  it('menonaktifkan semua kontrol saat disabled=true', () => {
    renderPagination({ page: 3, totalPages: 10, disabled: true })

    expect(screen.getByRole('button', { name: /Halaman sebelumnya/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Halaman berikutnya/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Halaman 1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Halaman 3' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Halaman 10' })).toBeDisabled()
  })

  it('mencegah onPageChange dipanggil saat disabled', () => {
    const { onPageChange } = renderPagination({ page: 3, totalPages: 10, disabled: true })

    fireEvent.click(screen.getByRole('button', { name: 'Halaman 4' }))

    expect(onPageChange).not.toHaveBeenCalled()
  })

  it('mencegah onPageChange dipanggil saat klik halaman aktif', () => {
    const { onPageChange } = renderPagination({ page: 3, totalPages: 10 })

    fireEvent.click(screen.getByRole('button', { name: 'Halaman 3' }))

    expect(onPageChange).not.toHaveBeenCalled()
  })

  it('mencegah onPageChange dipanggil saat klik di luar rentang', () => {
    const { onPageChange } = renderPagination({ page: 1, totalPages: 5 })

    // Tidak ada tombol halaman 0 atau 6, sehingga tidak ada yang bisa diklik di luar rentang.
    // Verifikasi prev di halaman 1 tidak memicu (sudah disabled).
    fireEvent.click(screen.getByRole('button', { name: /Halaman sebelumnya/ }))
    expect(onPageChange).not.toHaveBeenCalled()
  })

  it('menyembunyikan info saat showInfo=false', () => {
    renderPagination({ showInfo: false })

    expect(screen.queryByText(/Halaman \d+ dari \d+/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Halaman sebelumnya/ })).toBeInTheDocument()
  })

  it('menerima className tambahan', () => {
    renderPagination({ className: 'custom-pagination' })

    expect(screen.getByRole('navigation')).toHaveClass('custom-pagination')
  })

  it('tidak merender selektor ukuran halaman saat onPageSizeChange tidak diberikan', () => {
    renderPagination({ page: 1, totalPages: 5 })

    expect(screen.queryByLabelText(/Baris per halaman/)).not.toBeInTheDocument()
  })

  it('merender selektor ukuran halaman dengan 4 opsi dan nilai pageSize saat ini', () => {
    renderPagination({ page: 1, totalPages: 5, pageSize: 20, onPageSizeChange: vi.fn() })

    const select = screen.getByLabelText(/Baris per halaman/)
    expect(select).toHaveAttribute('aria-label', 'Baris per halaman')
    expect(select).toHaveValue('20')

    const options = Array.from(select.querySelectorAll('option'))
    expect(options).toHaveLength(4)
    expect(options.map((o) => o.textContent)).toEqual([
      '10 / halaman',
      '20 / halaman',
      '50 / halaman',
      '100 / halaman',
    ])
    expect(options.map((o) => o.value)).toEqual(['10', '20', '50', '100'])
  })

  it('memanggil onPageSizeChange dengan angka (bukan string) saat opsi dipilih', () => {
    const onPageSizeChange = vi.fn()
    renderPagination({ page: 1, totalPages: 5, pageSize: 10, onPageSizeChange })

    const select = screen.getByLabelText(/Baris per halaman/)
    fireEvent.change(select, { target: { value: '50' } })

    expect(onPageSizeChange).toHaveBeenCalledTimes(1)
    expect(onPageSizeChange).toHaveBeenCalledWith(50)
    expect(typeof onPageSizeChange.mock.calls[0]![0]).toBe('number')
  })

  it('menonaktifkan selektor ukuran halaman saat disabled=true', () => {
    renderPagination({
      page: 1,
      totalPages: 5,
      pageSize: 20,
      onPageSizeChange: vi.fn(),
      disabled: true,
    })

    expect(screen.getByLabelText(/Baris per halaman/)).toBeDisabled()
  })

  it('memakai label nav kustom saat ariaLabel diberikan', () => {
    renderPagination({ page: 1, totalPages: 5, ariaLabel: 'Paginasi daftar user' })

    expect(screen.getByRole('navigation', { name: 'Paginasi daftar user' })).toBeInTheDocument()
  })

  it('mempertahankan label nav default "Paginasi kunjungan" saat ariaLabel tidak diberikan', () => {
    renderPagination({ page: 1, totalPages: 5 })

    expect(screen.getByRole('navigation', { name: 'Paginasi kunjungan' })).toBeInTheDocument()
  })
})
