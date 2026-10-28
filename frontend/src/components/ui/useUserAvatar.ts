'use client'

import { useEffect, useState } from 'react'
import { fetchAvatarBlob } from '@/lib/api/avatars'

/** Hasil hook — object URL siap pakai dan status memuat. */
export interface UseUserAvatarResult {
  objectUrl: string | null
  loading: boolean
}

const EMPTY = ''

/**
 * Muat avatar pengguna sebagai blob → object URL lokal (tahan lintas host;
 * tidak pernah menempel URL storage ke markup, dan request selalu membawa
 * header `Authorization`).
 *
 * - `avatarUrl` kosong/`null` → tidak ada request sama sekali; state direset.
 * - Sukses → `objectUrl` diawali `blob:`; dilepas (`revokeObjectURL`) saat
 *   unmount / URL berganti agar tidak bocor memori.
 * - Gagal → `objectUrl` tetap `null` (komponen jatuh ke inisial); TIDAK
 *   melempar ke pemanggil dan tidak menampilkan galat UI.
 */
export function useUserAvatar(avatarUrl: string | null | undefined): UseUserAvatarResult {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const trimmed = avatarUrl?.trim() ?? EMPTY

    let active = true
    let createdUrl: string | null = null

    /* eslint-disable react-hooks/set-state-in-effect -- reset-on-change: state
       lama harus dikosongkan sebelum fetch berikutnya, dan effect ini
       satu-satunya pemilik lifecycle object URL (cleanup yang membatalkan
       revoke). */
    setObjectUrl(null)

    if (trimmed === EMPTY) {
      setLoading(false)
      return
    }

    setLoading(true)
    /* eslint-enable react-hooks/set-state-in-effect */

    fetchAvatarBlob(trimmed)
      .then((blob) => {
        if (!active) return
        const nextUrl = URL.createObjectURL(blob)
        createdUrl = nextUrl
        setObjectUrl(nextUrl)
      })
      .catch(() => {
        // Gagal muat bukan galat UI: biarkan `objectUrl` null → inisial.
        if (active) setObjectUrl(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
      if (createdUrl !== null) {
        URL.revokeObjectURL(createdUrl)
      }
    }
  }, [avatarUrl])

  return { objectUrl, loading }
}
