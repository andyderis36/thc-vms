// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { PasswordInput } from './PasswordInput'

function ControlledPasswordInput() {
  const [value, setValue] = useState('rahasia123')
  return (
    <PasswordInput
      label="Kata Sandi"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  )
}

describe('PasswordInput', () => {
  afterEach(() => {
    // cleanup handled by testing-library automatically in jsdom env
  })

  it('renders input type password by default with toggle label "Tampilkan kata sandi"', () => {
    render(<ControlledPasswordInput />)

    const input = screen.getByLabelText<HTMLInputElement>('Kata Sandi')
    expect(input).toHaveAttribute('type', 'password')

    const toggle = screen.getByRole('button', { name: 'Tampilkan kata sandi' })
    expect(toggle).toBeInTheDocument()
  })

  it('toggles input type to text and back, preserving value', () => {
    render(<ControlledPasswordInput />)

    const input = screen.getByLabelText<HTMLInputElement>('Kata Sandi')
    expect(input).toHaveValue('rahasia123')

    const showButton = screen.getByRole('button', { name: 'Tampilkan kata sandi' })
    fireEvent.click(showButton)

    const textInput = screen.getByLabelText<HTMLInputElement>('Kata Sandi')
    expect(textInput).toHaveAttribute('type', 'text')
    expect(textInput).toHaveValue('rahasia123')

    const hideButton = screen.getByRole('button', { name: 'Sembunyikan kata sandi' })
    expect(hideButton).toBeInTheDocument()

    fireEvent.click(hideButton)
    const passwordInput = screen.getByLabelText<HTMLInputElement>('Kata Sandi')
    expect(passwordInput).toHaveAttribute('type', 'password')
    expect(passwordInput).toHaveValue('rahasia123')
  })

  it('updates value through onChange', () => {
    render(<ControlledPasswordInput />)

    const input = screen.getByLabelText<HTMLInputElement>('Kata Sandi')
    fireEvent.change(input, { target: { value: 'baru456' } })

    expect(input).toHaveValue('baru456')
  })

  it('toggle is a plain icon button: transparent background, no hover background, keeps 44px touch target', () => {
    render(<ControlledPasswordInput />)

    const toggle = screen.getByRole('button', { name: 'Tampilkan kata sandi' })
    const className = toggle.className

    expect(className).toContain('bg-transparent')
    expect(className).not.toMatch(/hover:bg-/)
    expect(className).toContain('min-h-touch')
    expect(className).toContain('min-w-touch')
  })
})
