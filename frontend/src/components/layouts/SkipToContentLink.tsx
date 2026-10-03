/**
 * Skip-to-content — tautan pertama yang menerima fokus keyboard pada tiap shell.
 *
 * Menembak langsung ke landmark `<main id="main-content">` sehingga pengguna
 * keyboard / pembaca layar tidak menelusuri seluruh navigasi setiap muat halaman.
 *
 * Tersembunyi di luar viewport memakai TRANSFORM (`-translate-y-40`), bukan
 * properti layout — sesuai aturan animasi design system (hanya transform /
 * opacity / filter yang boleh dianimasikan) dan aman terhadap perhitungan
 * layout flex/grid. Muncul kembali saat menerima fokus (`focus:translate-y-0`).
 */
export function SkipToContentLink() {
  return (
    <a
      href="#main-content"
      className="fixed left-4 top-4 z-[60] -translate-y-40 rounded-control bg-brand px-4 py-3 text-label font-bold text-brand-contrast shadow-modal transition-transform duration-150 focus:translate-y-0 motion-reduce:transition-none"
    >
      Lewati ke konten utama
    </a>
  )
}
