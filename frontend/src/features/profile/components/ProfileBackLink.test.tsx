// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ProfileBackLink } from './ProfileBackLink'

afterEach(cleanup)

describe('ProfileBackLink', () => {
  it('merender link dengan href dan teks label yang terlihat', () => {
    render(<ProfileBackLink href="/gate" label="Gate Check-in" />)

    const link = screen.getByRole('link', { name: 'Gate Check-in' })
    expect(link).toHaveAttribute('href', '/gate')
    expect(link).toHaveTextContent('Gate Check-in')
  })

  it('menyertakan svg (ArrowLeft) dengan aria-hidden="true"', () => {
    const { container } = render(<ProfileBackLink href="/gate" label="Gate Check-in" />)

    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('aria-hidden', 'true')
  })

  it('className root memuat min-h-touch dan rounded-control', () => {
    render(<ProfileBackLink href="/gate" label="Gate Check-in" />)

    const link = screen.getByRole('link', { name: 'Gate Check-in' })
    expect(link.className).toContain('min-h-touch')
    expect(link.className).toContain('rounded-control')
  })

  it('className root TIDAK memakai radius Tailwind mentah rounded-lg/md/xl', () => {
    render(<ProfileBackLink href="/gate" label="Gate Check-in" />)

    const link = screen.getByRole('link', { name: 'Gate Check-in' })
    expect(link.className).not.toContain('rounded-lg')
    expect(link.className).not.toContain('rounded-md')
    expect(link.className).not.toContain('rounded-xl')
  })

  it('tidak punya keturunan interaktif bersarang', () => {
    render(<ProfileBackLink href="/gate" label="Gate Check-in" />)

    const link = screen.getByRole('link', { name: 'Gate Check-in' })
    expect(link.querySelector('a, button, input, select, textarea')).toBeNull()
  })

  it('props className opsional ditambahkan ke className root', () => {
    render(<ProfileBackLink href="/gate" label="Gate Check-in" className="mt-2" />)

    const link = screen.getByRole('link', { name: 'Gate Check-in' })
    expect(link.className).toContain('mt-2')
  })
})
