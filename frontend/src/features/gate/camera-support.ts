/**
 * Klasifikasi kegagalan kamera untuk frame scanner (SCR-05).
 *
 * Browser memblokir kamera di SELURUH konteks non-secure: `http://` pada IP
 * LAN bukan secure context, jadi `navigator.mediaDevices` tidak pernah
 * diekspos dan tak ada prompt izin yang bisa muncul. Pesan "izin kamera
 * ditolak" untuk kasus itu menyesatkan — petugas akan mencari pengaturan
 * yang memang tidak ada. Karena itu penyebabnya dipisah dari penolakan izin
 * sungguhan.
 *
 * Modul ini murni logika (tanpa DOM) supaya bisa diuji unit; pemanggilnya
 * yang menyediakan facts dari browser.
 */

/** Penyebab kamera tidak dapat dipakai, dari yang paling spesifik. */
export type CameraFailure =
  /** Konteks tidak aman (http:// di luar localhost) — kamera diblokir browser. */
  | 'insecure-context'
  /** Pengguna / browser menolak izin kamera. */
  | 'permission-denied'
  /** Tidak ada kamera yang bisa dipakai (device tidak punya / tidak dijangkau). */
  | 'not-found'
  /** Penyebab lain (mis. kamera dipakai aplikasi lain). */
  | 'unknown'

/** Facts yang hanya bisa dibaca browser. */
export interface CameraSupport {
  /** `window.isSecureContext` — true hanya di HTTPS atau localhost. */
  secureContext: boolean
  /** `navigator.mediaDevices.getUserMedia` tersedia? */
  mediaDevicesAvailable: boolean
}

/**
 * Klasifikasikan kegagalan start kamera. `errorName` adalah `name` dari error
 * yang dilempar browser (`NotAllowedError`, `NotFoundError`, ...).
 */
export function classifyCameraFailure(
  support: CameraSupport,
  errorName?: string,
): CameraFailure {
  // Konteks non-secure didahulukan: di sana blokirnya total, bukan izin.
  if (!support.secureContext || !support.mediaDevicesAvailable) {
    return 'insecure-context'
  }
  switch (errorName) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission-denied'
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return 'not-found'
    default:
      return 'unknown'
  }
}

/** Pesan yang tampil di frame scanner, sesuai penyebabnya. */
export function cameraFailureMessage(failure: CameraFailure): string {
  switch (failure) {
    case 'insecure-context':
      return 'Kamera hanya bisa aktif di alamat HTTPS. Alamat ini memakai HTTP, jadi browser memblokir kamera sepenuhnya — unggah gambar QR, gunakan Input Manual, atau akses lewat HTTPS.'
    case 'permission-denied':
      return 'Izin kamera ditolak. Izinkan akses kamera untuk situs ini, atau unggah gambar QR / gunakan Input Manual.'
    case 'not-found':
      return 'Kamera tidak ditemukan atau tidak bisa dipakai. Unggah gambar QR atau gunakan Input Manual.'
    default:
      return 'Kamera tidak dapat diakses. Izinkan akses kamera, unggah gambar QR, atau gunakan Input Manual.'
  }
}
