// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Purpose } from '@/lib/api/types'

import { PurposeDropdown } from './PurposeDropdown'

const PURPOSES: Purpose[] = [
  { id: 'p1', name: 'Splicing FO' },
  { id: 'p2', name: 'Maintenance Genset' },
]

const PLACEHOLDER = 'Pilih tujuan kunjungan'

function renderDropdown(overrides: Partial<Parameters<typeof PurposeDropdown>[0]> = {}) {
  const onToggle = vi.fn()
  const result = render(
    <PurposeDropdown
      label="Tujuan Kunjungan"
      purposes={PURPOSES}
      selectedIds={[]}
      onToggle={onToggle}
      placeholder={PLACEHOLDER}
      isLoading={false}
      isError={false}
      {...overrides}
    />,
  )
  return { onToggle, ...result }
}

function openPanel() {
  fireEvent.click(screen.getByRole('button'))
}

describe('PurposeDropdown', () => {
  it('menampilkan placeholder saat belum ada tujuan yang dipilih', () => {
    renderDropdown()
    expect(screen.getByRole('button')).toHaveTextContent(PLACEHOLDER)
  })

  it('menampilkan ringkasan jumlah tujuan yang dipilih', () => {
    renderDropdown({ selectedIds: ['p1', 'p2'] })
    expect(screen.getByRole('button')).toHaveTextContent('2 tujuan dipilih')
  })

  it('memanggil onToggle dengan id tujuan saat checkbox diklik lalu ringkasan ikut berubah', () => {
    const { onToggle, rerender } = renderDropdown()
    openPanel()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Maintenance Genset' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('p2')

    rerender(
      <PurposeDropdown
        label="Tujuan Kunjungan"
        purposes={PURPOSES}
        selectedIds={['p2']}
        onToggle={onToggle}
        placeholder={PLACEHOLDER}
        isLoading={false}
        isError={false}
      />,
    )
    expect(screen.getByRole('button')).toHaveTextContent('1 tujuan dipilih')
    expect(screen.getByRole('checkbox', { name: 'Maintenance Genset' })).toBeChecked()
    expect(screen.getByRole('option', { name: 'Maintenance Genset' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('memasang aria-controls hanya saat panel terbuka dan menunjuk ke listbox', () => {
    renderDropdown()
    const button = screen.getByRole('button')

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).not.toHaveAttribute('aria-controls')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    openPanel()

    const panelId = button.getAttribute('aria-controls')
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(panelId).toBeTruthy()
    const panel = screen.getByRole('listbox')
    expect(panel.getAttribute('id')).toBe(panelId)
    expect(panel).toHaveAttribute('aria-multiselectable', 'true')
  })

  it('menutup panel saat tombol Escape ditekan', () => {
    renderDropdown()
    openPanel()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-controls')
  })

  it('menutup panel saat klik di luar field', () => {
    renderDropdown()
    openPanel()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-controls')
  })

  it('menampilkan status memuat dan menonaktifkan tombol', () => {
    renderDropdown({ isLoading: true })
    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Memuat tujuan kunjungan…')
  })

  it('menampilkan pesan galat dan menonaktifkan tombol saat daftar gagal dimuat', () => {
    renderDropdown({ isError: true })
    expect(screen.getByRole('button')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Gagal memuat daftar tujuan kunjungan. Silakan muat ulang halaman.',
    )
  })

  it('menampilkan pesan galat validasi bila ada', () => {
    renderDropdown({ error: 'Minimal pilih 1 tujuan kunjungan.' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Minimal pilih 1 tujuan kunjungan.',
    )
  })
})
