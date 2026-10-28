// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UserAvatar } from './UserAvatar'

const NAME = 'Budi Santoso'

function wrapperOf(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector('[data-avatar-state]')
  expect(wrapper).not.toBeNull()
  return wrapper as HTMLElement
}

describe('UserAvatar', () => {
  it('menampilkan <img> dari avatarUrl dan menandai wrapper sebagai state image', () => {
    const { container } = render(<UserAvatar name={NAME} avatarUrl="https://cdn.example/u.png" />)

    const wrapper = wrapperOf(container)
    expect(wrapper).toHaveAttribute('data-avatar-state', 'image')
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')

    const img = wrapper.querySelector('img')
    expect(img).toHaveAttribute('src', 'https://cdn.example/u.png')
    expect(img).toHaveAttribute('alt', '')
    expect(wrapper.textContent).toBe('')
  })

  it('jatuh ke inisial ketika avatarUrl null', () => {
    const { container } = render(<UserAvatar name={NAME} avatarUrl={null} />)

    const wrapper = wrapperOf(container)
    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper.querySelector('img')).toBeNull()
    expect(wrapper.textContent).toBe('BS')
  })

  it('jatuh ke inisial ketika avatarUrl kosong', () => {
    const { container } = render(<UserAvatar name={NAME} avatarUrl="" />)

    const wrapper = wrapperOf(container)
    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper.querySelector('img')).toBeNull()
    expect(wrapper.textContent).toBe('BS')
  })

  it('berganti ke inisial saat <img> gagal dimuat (URL kedaluwarsa)', () => {
    const { container } = render(<UserAvatar name={NAME} avatarUrl="https://cdn.example/expired.png" />)
    const img = wrapperOf(container).querySelector('img')
    expect(img).not.toBeNull()

    fireEvent.error(img!)

    const wrapper = wrapperOf(container)
    expect(wrapper).toHaveAttribute('data-avatar-state', 'initials')
    expect(wrapper.querySelector('img')).toBeNull()
    expect(wrapper.textContent).toBe('BS')
  })

  it('mencoba <img> lagi saat avatarUrl baru diberikan setelah error', () => {
    const { container, rerender } = render(
      <UserAvatar name={NAME} avatarUrl="https://cdn.example/expired.png" />,
    )
    fireEvent.error(wrapperOf(container).querySelector('img')!)
    expect(wrapperOf(container)).toHaveAttribute('data-avatar-state', 'initials')

    rerender(<UserAvatar name={NAME} avatarUrl="https://cdn.example/fresh.png" />)

    const wrapper = wrapperOf(container)
    expect(wrapper).toHaveAttribute('data-avatar-state', 'image')
    expect(wrapper.querySelector('img')).toHaveAttribute('src', 'https://cdn.example/fresh.png')
  })

  it('memetakan ukuran sm/md/lg dan nada onBrand ke kelas tema', () => {
    const sm = render(<UserAvatar name={NAME} size="sm" />)
    expect(wrapperOf(sm.container)).toHaveClass('size-8', 'text-badge')
    sm.unmount()

    const md = render(<UserAvatar name={NAME} />)
    expect(wrapperOf(md.container)).toHaveClass('size-10', 'text-sm', 'bg-brand', 'text-brand-contrast')
    md.unmount()

    const lg = render(<UserAvatar name={NAME} size="lg" />)
    expect(wrapperOf(lg.container)).toHaveClass('size-12', 'text-lg')
    lg.unmount()

    const onBrand = render(<UserAvatar name={NAME} tone="onBrand" />)
    expect(wrapperOf(onBrand.container)).toHaveClass('bg-brand-soft', 'text-brand')
    expect(wrapperOf(onBrand.container)).not.toHaveClass('bg-brand')
  })
})
