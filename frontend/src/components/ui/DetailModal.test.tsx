// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DetailModal, isEmptyDetailValue, type DetailField } from './DetailModal'
import { UserAvatar } from './UserAvatar'

const FIELDS: DetailField[] = [
  { label: 'NAMA', value: 'Budi Santoso' },
  { label: 'EMAIL', value: 'budi.santoso@thc.net.id' },
  { label: 'TELEPON', value: '' },
  { label: 'NIK', value: null },
  { label: 'STATUS', value: <span>Aktif</span> },
]

function renderDetail(overrides: Partial<Parameters<typeof DetailModal>[0]> = {}) {
  const onClose = vi.fn()
  const props = {
    title: 'Detail User',
    subtitle: 'Budi Santoso',
    fields: FIELDS,
    onClose,
    ...overrides,
  }
  const result = render(<DetailModal {...props} />)
  return { onClose, ...result }
}

/** Sel nilai (`<dd>`) milik satu label. */
function valueCell(label: string): HTMLElement {
  const term = screen.getByText(label)
  const definition = term.parentElement?.querySelector('dd')
  if (definition === null || definition === undefined) {
    throw new Error(`sel nilai untuk "${label}" tidak ditemukan`)
  }
  return definition
}

describe('isEmptyDetailValue', () => {
  it('menilai null, undefined, string kosong, dan false sebagai kosong', () => {
    expect(isEmptyDetailValue(null)).toBe(true)
    expect(isEmptyDetailValue(undefined)).toBe(true)
    expect(isEmptyDetailValue('')).toBe(true)
    expect(isEmptyDetailValue('   ')).toBe(true)
    expect(isEmptyDetailValue(false)).toBe(true)
  })

  it('bukan regards nilai sah termasuk angka nol', () => {
    expect(isEmptyDetailValue('Aktif')).toBe(false)
    expect(isEmptyDetailValue(0)).toBe(false)
    expect(isEmptyDetailValue(<span>Aktif</span>)).toBe(false)
  })
})

describe('DetailModal', () => {
  it('merender dialog bermodal dengan judul yang terhubung lewat aria-labelledby', () => {
    renderDetail()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).not.toBeNull()
    expect(document.getElementById(labelledBy ?? '')).toHaveTextContent('Detail User')
  })

  it('merender seluruh label dan nilai sesuai urutan fields', () => {
    renderDetail()

    const terms = screen.getAllByRole('term').map((term) => term.textContent)
    expect(terms).toEqual(['NAMA', 'EMAIL', 'TELEPON', 'NIK', 'STATUS'])
    expect(valueCell('NAMA')).toHaveTextContent('Budi Santoso')
    expect(valueCell('EMAIL')).toHaveTextContent('budi.santoso@thc.net.id')
    expect(valueCell('STATUS')).toHaveTextContent('Aktif')
  })

  it('menampilkan strip redup untuk nilai kosong, bukan sel kosong', () => {
    renderDetail()

    for (const label of ['TELEPON', 'NIK']) {
      const cell = valueCell(label)
      expect(cell).toHaveTextContent('—')
      expect(cell.textContent?.trim()).toBe('—')
      expect(cell.querySelector('.text-ink-muted')).not.toBeNull()
    }
  })

  it('tidak memuat input maupun tombol submit — hanya kontrol tutup', () => {
    renderDetail()

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    const buttons = within(screen.getByRole('dialog')).getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button).toHaveAttribute('type', 'button')
    }
  })

  it('menutup dengan Escape', () => {
    const { onClose } = renderDetail()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('memindahkan fokus ke dalam dialog saat dibuka', () => {
    renderDetail()

    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('menjebak fokus: Tab dari tombol terakhir kembali ke tombol pertama', () => {
    renderDetail()

    const dialog = screen.getByRole('dialog')
    const buttons = within(dialog).getAllByRole('button')
    const first = buttons[0]!
    const last = buttons[buttons.length - 1]!

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})

describe('DetailModal — slot avatar', () => {
  const AVATAR_URL = 'https://minio.local/avatars/budi.png'

  function avatarWrapper(dialog: HTMLElement): HTMLElement {
    const wrapper = dialog.querySelector('[data-avatar-state]')
    expect(wrapper).not.toBeNull()
    return wrapper as HTMLElement
  }

  it('menampilkan <img> avatar dari URL yang diberikan, di baris header bersama subtitle', () => {
    renderDetail({ avatar: <UserAvatar name="Budi Santoso" avatarUrl={AVATAR_URL} /> })

    const dialog = screen.getByRole('dialog')
    const wrapper = avatarWrapper(dialog)
    expect(wrapper).toHaveAttribute('data-avatar-state', 'image')
    const img = wrapper.querySelector('img')
    expect(img).toHaveAttribute('src', AVATAR_URL)

    const row = dialog.querySelector('div.mb-3') as HTMLElement
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('Budi Santoso')
    expect(row.contains(wrapper)).toBe(true)
    expect(dialog.querySelector('dl')?.contains(wrapper)).toBe(false)
  })

  it('jatuh ke inisial ketika avatar_url null', () => {
    renderDetail({ avatar: <UserAvatar name="Budi Santoso" avatarUrl={null} /> })

    const wrapper = avatarWrapper(screen.getByRole('dialog'))
    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper.querySelector('img')).toBeNull()
    expect(wrapper.textContent).toBe('BS')
  })

  it('tanpa prop avatar mempertahankan markup subtitle lama tanpa elemen ekstra', () => {
    renderDetail()

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[data-avatar-state]')).toBeNull()

    const subtitle = dialog.querySelector('p.mb-3')
    expect(subtitle).not.toBeNull()
    expect(subtitle).toHaveTextContent('Budi Santoso')
    expect(subtitle).toHaveClass('text-sm', 'text-ink-secondary')
  })
})
