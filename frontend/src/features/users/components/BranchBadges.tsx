import { Badge } from '@/components/ui/Badge'

/**
 * Pil nama cabang untuk baris detail ("CABANG" / "CABANG / VENDOR") — satu
 * resep visual untuk modal Detail User (`/coordinators`,
 * `/vendor-registrations`) dan Detail Pengawas (`/security`), sehingga
 * multi-cabang selalu tampil konsisten: satu pil per cabang, membungkus ke
 * baris berikutnya di layar sempit (tumpukan kartu 390px tanpa scroll
 * horizontal).
 *
 * Warna memakai nada `neutral` bawaan `Badge` (chip generik lokasi) — tanpa
 * warna hardcoded.
 */
export function BranchBadges({ names }: { names: readonly string[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {names.map((name, index) => (
        <Badge key={`${name}-${index}`}>{name}</Badge>
      ))}
    </span>
  )
}
