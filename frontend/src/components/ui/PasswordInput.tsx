'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

import { Input, type InputProps } from './Input'

export type PasswordInputProps = Omit<InputProps, 'type'>

/**
 * Field kata sandi dengan tombol tampilkan/sembunyikan. Membungkus `Input`
 * yang sudah ada; nilai tidak pernah dihapus saat toggle (state hanya
 * mengubah `type` input, sedangkan value tetap dikendalikan induk).
 */
export function PasswordInput(props: PasswordInputProps) {
  const [show, setShow] = useState(false)
  const toggleLabel = show ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'

  return (
    <Input
      {...props}
      type={show ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          aria-label={toggleLabel}
          onClick={() => setShow((previous) => !previous)}
          className="inline-flex min-h-touch min-w-touch items-center justify-center border-0 bg-transparent text-ink-secondary shadow-none focus-visible:ring-4 focus-visible:ring-brand/12 focus-visible:outline-none"
        >
          {show ? (
            <EyeOff className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <Eye className="size-4 shrink-0" aria-hidden="true" />
          )}
        </button>
      }
    />
  )
}
