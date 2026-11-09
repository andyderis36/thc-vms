'use client'

import { useVendorsQuery, useVendorSuggestionsQuery } from '@/lib/api/hooks'
import type { Vendor } from '@/lib/api/types'
import { mergeSuggestionNames } from '@/lib/visits/suggestions'

/** Hasil gabungan: katalog untuk resolusi submit + nama untuk `<datalist>`. */
export interface VendorNameOptions {
  /** Katalog vendor terdaftar — dipakai `resolveVendorInput` saat submit. */
  vendors: Vendor[]
  /** Nama terdedupe (saran feed lebih dulu, lalu pelengkap katalog). */
  names: string[]
  /** True selama katalog dimuat (placeholder input). */
  isPending: boolean
}

/**
 * Satu sumber nama vendor untuk `<datalist>` pada modal akun terkelola:
 * feed `GET /vendors/suggestions` (peran admin/super_admin, digerbangi di
 * hook saran) DILENGKAPI katalog `GET /vendors`, sehingga nama yang dulu
 * tampil tidak pernah hilang saat feed kosong/galat. Katalog ikut
 * dikembalikan agar pemanggil tidak perlu memanggil `useVendorsQuery` lagi
 * untuk `resolveVendorInput`.
 */
export function useVendorNameOptions(enabled = true): VendorNameOptions {
  const vendorsQuery = useVendorsQuery(enabled)
  const suggestionsQuery = useVendorSuggestionsQuery('', enabled)
  const vendors = vendorsQuery.data ?? []
  return {
    vendors,
    names: mergeSuggestionNames(suggestionsQuery.data, vendors),
    isPending: vendorsQuery.isPending,
  }
}
