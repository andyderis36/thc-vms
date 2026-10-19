// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'

import { ActionMenu, type ActionMenuItem, type ActionMenuProps } from './ActionMenu'

const LABEL = 'Aksi untuk Budi Santoso'

function renderActionMenu(overrides: Partial<ActionMenuProps> = {}) {
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  const items: ActionMenuItem[] = [
    { id: 'edit', label: 'Ubah', onSelect: onEdit },
    { id: 'delete', label: 'Hapus', tone: 'danger', onSelect: onDelete },
  ]

  const result = render(<ActionMenu label={LABEL} items={items} {...overrides} />)

  return { onEdit, onDelete, ...result }
}

/** Buka menu lewat klik pada pemicu. */
function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: LABEL }))
}

const HOST_ITEMS: ActionMenuItem[] = [
  { id: 'edit', label: 'Ubah', onSelect: vi.fn() },
  { id: 'delete', label: 'Hapus', tone: 'danger', onSelect: vi.fn() },
]

/**
 * Meniru `Modal.tsx`: sebuah listener `keydown` level-document yang menutup
 * permukaan induk saat Escape ditekan. Dipakai untuk membuktikan `ActionMenu`
 * tidak menyerap Escape ketika tertutup (sehingga modal tetap bisa menutup
 * dengan satu tekanan).
 */
function EscapeHost({ onEscape }: { onEscape: () => void }) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onEscape()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onEscape])

  return (
    <div>
      <ActionMenu label={LABEL} items={HOST_ITEMS} />
      <button type="button" onClick={onEscape}>
        Tombol saudara
      </button>
    </div>
  )
}

describe('ActionMenu', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tertutup secara default tanpa role="menu" dan aria-expanded="false"', () => {
    renderActionMenu()

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: LABEL })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).not.toHaveAttribute('aria-controls')
  })

  it('membuka menu saat pemicu diklik dengan ARIA dan id panel yang terhubung', () => {
    renderActionMenu()
    openMenu()

    const trigger = screen.getByRole('button', { name: LABEL })
    const menu = screen.getByRole('menu')
    const menuId = trigger.getAttribute('aria-controls') ?? ''

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(menuId).not.toBe('')
    expect(menu).toHaveAttribute('id', menuId)
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2)
  })

  it('menerapkan gaya danger dan menghormati item disabled', () => {
    renderActionMenu({
      items: [
        { id: 'edit', label: 'Ubah', onSelect: vi.fn() },
        { id: 'delete', label: 'Hapus', tone: 'danger', onSelect: vi.fn() },
        { id: 'archive', label: 'Arsipkan', onSelect: vi.fn(), disabled: true },
      ],
    })
    openMenu()

    const danger = screen.getByRole('menuitem', { name: 'Hapus' })
    expect(danger).toHaveClass('text-danger-text')
    expect(danger).toHaveClass('hover:bg-danger-bg')

    expect(screen.getByRole('menuitem', { name: 'Arsipkan' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Ubah' })).not.toBeDisabled()
  })

  it('memanggil onSelect tepat sekali dan menutup menu setelah item dipilih', () => {
    const { onEdit } = renderActionMenu()
    openMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Ubah' }))

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: LABEL })).toHaveAttribute('aria-expanded', 'false')
  })

  it('menutup menu dengan Escape dan mengembalikan fokus ke pemicu', () => {
    renderActionMenu()
    openMenu()

    const trigger = screen.getByRole('button', { name: LABEL })
    fireEvent.keyDown(trigger, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('menutup menu pada pointerdown di luar, tetapi tidak saat pointerdown di dalam panel portal', () => {
    renderActionMenu()
    openMenu()

    const menu = screen.getByRole('menu')
    fireEvent.pointerDown(within(menu).getByRole('menuitem', { name: 'Ubah' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('membuka dengan ArrowDown dan memfokuskan item pertama, lalu berpindah ke item berikutnya', () => {
    renderActionMenu()
    const trigger = screen.getByRole('button', { name: LABEL })

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    const first = screen.getByRole('menuitem', { name: 'Ubah' })
    expect(first).toHaveFocus()

    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Hapus' })).toHaveFocus()
  })

  it('menonaktifkan pemicu dan menandai aria-busy saat busy=true', () => {
    renderActionMenu({ busy: true })

    const trigger = screen.getByRole('button', { name: LABEL })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('tidak merender apa pun saat daftar item kosong', () => {
    const { container } = renderActionMenu({ items: [] })

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('menyediakan nama aksesibel non-kosong dari prop label', () => {
    renderActionMenu()

    const trigger = screen.getByRole('button', { name: LABEL })
    expect(trigger).toHaveAccessibleName(LABEL)
  })

  it('merender panel ke document.body, memakai fixed + z-[60], dan membalik ke atas saat ruang bawah habis', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(500)

    renderActionMenu()
    const trigger = screen.getByRole('button', { name: LABEL })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 600,
      y: 400,
      top: 400,
      bottom: 444,
      left: 600,
      right: 644,
      width: 44,
      height: 44,
      toJSON: () => ({}),
    } as DOMRect)

    fireEvent.click(trigger)

    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(menu).toHaveClass('fixed')
    expect(menu).toHaveClass('z-[60]')
    // 2 item × 44px + padding panel = 98px; 448 + 98 > 500 → flip ke 400 - 98 - 4.
    expect(menu.style.top).toBe('298px')
    // align end: 644 - lebar panel 224px.
    expect(menu.style.left).toBe('420px')
  })

  it('melepas pemicu tanpa melempar saat items berubah dari terisi menjadi kosong (regresi Rules of Hooks)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = renderActionMenu()

    expect(screen.getByRole('button', { name: LABEL })).toBeInTheDocument()

    expect(() => rerender(<ActionMenu label={LABEL} items={[]} />)).not.toThrow()

    expect(screen.queryByRole('button', { name: LABEL })).not.toBeInTheDocument()

    const hookOrderErrors = errorSpy.mock.calls.filter((call) =>
      call.some((arg) =>
        arg instanceof Error
          ? /fewer hooks/i.test(arg.message)
          : typeof arg === 'string' && /fewer hooks/i.test(arg),
      ),
    )
    expect(hookOrderErrors).toEqual([])
  })

  it('tidak menyerap Escape saat tertutup sehingga listener document-level modal induk tetap jalan', () => {
    const onEscape = vi.fn()
    render(<EscapeHost onEscape={onEscape} />)

    const trigger = screen.getByRole('button', { name: LABEL })
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Escape' })

    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('menyerap Escape saat terbuka sehingga hanya menu yang tertutup, bukan modal induk', () => {
    const onEscape = vi.fn()
    render(<EscapeHost onEscape={onEscape} />)

    const trigger = screen.getByRole('button', { name: LABEL })
    fireEvent.click(trigger)
    const item = screen.getByRole('menuitem', { name: 'Ubah' })

    fireEvent.keyDown(item, { key: 'Escape' })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('menutup menu saat window di-scroll', () => {
    renderActionMenu()
    openMenu()
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.scroll(window)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('menutup menu saat window di-resize', () => {
    renderActionMenu()
    openMenu()
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.resize(window)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
