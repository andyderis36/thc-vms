'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ChevronDown, LogOut, Settings, UserRound } from 'lucide-react'
import { useUserAvatar } from '@/components/ui/useUserAvatar'

export interface ProfileMenuUser {
  name: string
  /** Label peran opsional (mis. "Admin Cabang") — ditampilkan di bawah nama. */
  role?: string
  /** URL foto profil opsional; bila kosong dipakai inisial nama. */
  avatarUrl?: string
}

export interface ProfileMenuProps {
  user: ProfileMenuUser
  onLogout: () => void
  /**
   * Tautan hub Pengaturan (mis. `/settings`) sebagai item menu di antara
   * Profil dan Keluar. Opsional agar shell tanpa layar pengaturan (vendor,
   * security, admin cabang) tidak menampilkan item buntu — hanya shell yang
   * mengisi prop ini yang merender itemnya.
   */
  settingsHref?: string
  /**
   * Slot opsional di bawah nama pada PEMICU (mis. lencana peran).
   * Bila diisi, slot ini menggantikan baris `user.role` bawaan pada pemicu;
   * header panel menu tetap menampilkan `user.role` sebagai teks.
   * Dipakai shell sidebar agar lencana peran berdiri DI DALAM kolom nama —
   * sejajar dengan nama, bukan melayang di baris sendiri.
   */
  roleSlot?: ReactNode
  /**
   * Tampilkan nama di samping avatar pada SEMUA lebar viewport.
   * Bawaan `false`: nama disembunyikan di bawah `sm` (pemuai topbar sempit).
   * Sidebar 250/260px punya lebar tetap, jadi nama wajib selalu terlihat agar
   * blok akun (avatar + nama + peran) terbaca utuh di semua breakpoint.
   */
  alwaysShowName?: boolean
}

/*
 * `max-w-full`: `<button>` dihitung shrink-to-fit, jadi lebarnya ikut
 * lebar intrinsik isinya. Nama yang `truncate` (tanpa wrap) memaksa tombol
 * selebar teks penuh dan meluber dari sidebar sempit. Rel ini menahan
 * tombol pada lebar induknya; kolom nama (`min-w-0`) lalu menyusut dan nama
 * dipotong elipsis.
 */
/*
 * State tekan: satu langkah lebih pekat dari hover (`bg-ink/10` di atas
 * `bg-neutral-bg`), hanya lewat background — tidak ada perubahan geometri,
 * jadi tidak ada layout shift. `active:` mengalahkan `hover:` karena
 * urutan varian CSS Tailwind v4 (lihat blok aturan di `Button.tsx`).
 */
const TRIGGER_CLASS =
  'flex max-w-full min-h-touch items-center gap-2 rounded-control px-2 text-left transition hover:bg-neutral-bg active:bg-ink/10 cursor-pointer'

const AVATAR_CLASS =
  'flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand text-label font-bold text-brand-contrast'

const PANEL_CLASS =
  'absolute right-0 top-full z-40 mt-1 w-56 rounded-control border border-border-mid bg-surface p-1 shadow-dropdown'

const ITEM_CLASS =
  'flex min-h-touch w-full items-center gap-2 rounded-control px-3 text-sm text-ink transition hover:bg-neutral-bg active:bg-ink/10 cursor-pointer'

/** Inisial maksimal 2 huruf — aman terhadap nama kosong. */
function initialsOf(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
  return initials === '' ? '?' : initials
}

/**
 * Dropdown profil shared untuk semua shell (SHELL-01..04).
 * Pemicu avatar + nama + panel menu berisi item "Profil" (tautan ke
 * `/profile`, self-service) dan "Keluar". Interaksi meniru pola
 * `PurposeDropdown` (klik-luar + Escape + refocus pemicu) tanpa dependensi
 * eksternal. Baris peran pada pemicu berasal dari `roleSlot` (bila ada) agar
 * shell sidebar bisa menyejajarkan lencana peran dengan kolom nama.
 */
export function ProfileMenu({ user, onLogout, settingsHref, roleSlot, alwaysShowName = false }: ProfileMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const generatedId = useId()
  const buttonId = `${generatedId}-button`
  const menuId = `${generatedId}-menu`

  // `avatar_url` adalah path terautentikasi, bukan URL storage — foto diambil
  // sebagai blob oleh hook; selama memuat/gagal yang tampil adalah inisial.
  const { objectUrl: avatarObjectUrl } = useUserAvatar(user.avatarUrl)

  // Tutup saat klik/tap di luar, atau Escape → refocus pemicu (pola PurposeDropdown/Modal).
  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && !containerRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      // Escape menutup LAPISAN TERATAS: menu akun di atas laci/drawer, jadi
      // Escape pertama menutup menu saja. Pendengar shell laci ada di
      // `window` (fase bubble), sedangkan pendengar ini di `document` — dan
      // `document` berada SEBELUM `window` pada jalur perambusan, sehingga
      // `stopPropagation()` di sini mencegah laci ikut tertutup. Escape kedua
      // (menu sudah tertutup → pendengar ini sudah dilepas) menembus ke
      // `window` dan menutup laci seperti biasa.
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={user.name}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={TRIGGER_CLASS}
      >
        <span role="img" aria-label={`Akun ${user.name}`} className={AVATAR_CLASS}>
          {avatarObjectUrl !== null ? (
            // eslint-disable-next-line @next/next/no-img-element -- src berupa object URL `blob:`, di luar jangkauan optimizer next/image.
            <img
              src={avatarObjectUrl}
              alt=""
              className="size-full object-cover"
              aria-hidden="true"
            />
          ) : (
            initialsOf(user.name)
          )}
        </span>
        {/* `min-w-0` + `truncate`: nama panjang dipotong dengan elipsis, tidak
            pernah mendorong chevron keluar sidebar. */}
        <span
          className={
            alwaysShowName
              ? 'flex min-w-0 flex-col items-start gap-1'
              : 'hidden min-w-0 flex-col items-start gap-1 sm:flex'
          }
        >
          <span className="max-w-full truncate text-sm font-semibold text-ink">{user.name}</span>
          {roleSlot ?? (user.role ? <span className="text-xs text-ink-muted">{user.role}</span> : null)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`.trim()}
        />
      </button>

      {open ? (
        <div id={menuId} role="menu" aria-labelledby={buttonId} className={PANEL_CLASS}>
          <div className="border-b border-border-mid px-3 py-2">
            <p className="text-sm font-semibold text-ink">{user.name}</p>
            {user.role ? <p className="text-xs text-ink-muted">{user.role}</p> : null}
          </div>
          <Link
            href="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={ITEM_CLASS}
          >
            <UserRound aria-hidden="true" className="size-4 shrink-0" />
            Profil
          </Link>
          {settingsHref !== undefined && settingsHref !== '' ? (
            <Link
              href={settingsHref}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={ITEM_CLASS}
            >
              <Settings aria-hidden="true" className="size-4 shrink-0" />
              Pengaturan
            </Link>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
            className={ITEM_CLASS}
          >
            <LogOut aria-hidden="true" className="size-4 shrink-0" />
            Keluar
          </button>
        </div>
      ) : null}
    </div>
  )
}
