'use client'

import { useEffect, useState } from 'react'

/**
 * Formatter jam WIB. `timeZone: 'Asia/Jakarta'` WAJIB eksplisit: kios pos
 * jaga dapat berjalan di perangkat dengan zona waktu sistem berbeda, sedangkan
 * seluruh fasilitas THC beroperasi di WIB (lihat `Location.timezone` pada
 * `lib/api/types.ts`). `hour12: false` menjaga format 24 jam.
 */
const WIB_TIME_FORMATTER = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/**
 * Helper murni: format jam menjadi `HH:MM:SS WIB`.
 *
 * Pemisah titik bawaan locale `id-ID` (mis. `14.30.15`) dinormalkan menjadi
 * colon agar sesuai spesifikasi `HH:MM:SS WIB`. Menerima `date` opsional
 * sehingga dapat diuji tanpa jam dinding.
 */
export function formatWibTime(date: Date = new Date()): string {
  const clock = WIB_TIME_FORMATTER.format(date).replace(/\./g, ':')
  return `${clock} WIB`
}

/** Placeholder sembari hidrasi; identik di server & klien pertama render. */
const PLACEHOLDER_TIME = '--:--:-- WIB'

export interface LiveClockProps {
  /** Kelas tambahan (ukuran teks, warna) dari shell pemakai. */
  className?: string
}

/**
 * Jam digital live `HH:MM:SS WIB` untuk kiosk pos jaga.
 *
 * - `setInterval` 1 detik dibersihkan pada cleanup (kiosk berjalan lama —
 *   tidak boleh ada kebocoran timer saat unmount).
 * - Render awal memakai placeholder lalu diisi langsung di `useEffect`,
 *   sehingga teks server = teks render pertama klien (tanpa warning
 *   hydration) dan jam langsung tampil tanpa menunggu detik berikutnya.
 * - Teks berdetak dibungkus `aria-hidden`; `aria-label` membawa waktu terkini
 *   sehingga pembaca layar membacanya saat disentuh, bukan tiap detik.
 */
export function LiveClock({ className = '' }: LiveClockProps) {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    const tick = (): void => setNow(new Date())
    tick()
    const timerId = window.setInterval(tick, 1000)
    return (): void => window.clearInterval(timerId)
  }, [])

  const timeText = now === null ? PLACEHOLDER_TIME : formatWibTime(now)

  return (
    <time
      dateTime={now === null ? undefined : now.toISOString()}
      aria-label={`Waktu sekarang ${timeText}`}
      className={['font-mono font-bold tabular-nums', className].filter(Boolean).join(' ')}
    >
      <span aria-hidden="true">{timeText}</span>
    </time>
  )
}
