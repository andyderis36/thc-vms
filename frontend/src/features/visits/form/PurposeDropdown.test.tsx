// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { PURPOSE_OPTIONS, PurposeDropdown } from './PurposeDropdown'

const PLACEHOLDER = 'Pilih keperluan kunjungan'

function renderDropdown(overrides: Partial<Parameters<typeof PurposeDropdown>[0]> = {}) {
  const onToggle = vi.fn()
  const result = render(
    <PurposeDropdown
      label="Keperluan Kunjungan"
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
  it('menampilkan placeholder saat belum ada keperluan yang dipilih', () => {
    renderDropdown()
    expect(screen.getByRole('button')).toHaveTextContent(PLACEHOLDER)
  })

  it('merender tepat empat opsi hardcoded keputusan produk', () => {
    renderDropdown()
    openPanel()
    expect(PURPOSE_OPTIONS).toEqual([
      'Survey',
      'Operation & Maintenance',
      'Project',
      'Other',
    ])
    for (const option of PURPOSE_OPTIONS) {
      expect(screen.getByRole('checkbox', { name: option })).toBeInTheDocument()
    }
    expect(screen.getAllByRole('option')).toHaveLength(4)
  })

  it('menampilkan ringkasan jumlah keperluan yang dipilih', () => {
    renderDropdown({ selectedIds: ['Survey', 'Project'] })
    expect(screen.getByRole('button')).toHaveTextContent('2 keperluan dipilih')
  })

  it('memanggil onToggle dengan nama keperluan saat checkbox diklik lalu ringkasan ikut berubah', () => {
    const { onToggle, rerender } = renderDropdown()
    openPanel()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Survey' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('Survey')

    rerender(
      <PurposeDropdown
        label="Keperluan Kunjungan"
        selectedIds={['Survey']}
        onToggle={onToggle}
        placeholder={PLACEHOLDER}
        isLoading={false}
        isError={false}
      />,
    )
    expect(screen.getByRole('button')).toHaveTextContent('1 keperluan dipilih')
    expect(screen.getByRole('checkbox', { name: 'Survey' })).toBeChecked()
    expect(screen.getByRole('option', { name: 'Survey' })).toHaveAttribute(
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
    expect(button).toHaveTextContent('Memuat keperluan kunjungan…')
  })

  it('menampilkan pesan galat dan menonaktifkan tombol saat daftar gagal dimuat', () => {
    renderDropdown({ isError: true })
    expect(screen.getByRole('button')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Gagal memuat daftar keperluan kunjungan. Silakan muat ulang halaman.',
    )
  })

  it('menampilkan pesan galat validasi bila ada', () => {
    renderDropdown({ error: 'Minimal pilih 1 keperluan kunjungan.' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Minimal pilih 1 keperluan kunjungan.',
    )
  })

  it('memakai id yang diberikan pada tombol pemicu bila prop id diisi', () => {
    renderDropdown({ id: 'visit-purpose' })
    expect(screen.getByRole('button', { name: /Keperluan Kunjungan/ })).toHaveAttribute(
      'id',
      'visit-purpose',
    )
  })
})
