import { describe, expect, it } from 'vitest'

import { paginate } from '@/lib/pagination'

function numberRows(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1)
}

describe('paginate', () => {
  it('halaman pertama mengembalikan slice pertama', () => {
    const result = paginate(numberRows(25), 1, 10)

    expect(result).toEqual({ items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], page: 1, totalPages: 3 })
  })

  it('halaman tengah mengembalikan jendela yang benar', () => {
    const result = paginate(numberRows(25), 2, 10)

    expect(result).toEqual({
      items: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      page: 2,
      totalPages: 3,
    })
  })

  it('halaman terakhir yang parsial mengembalikan sisanya', () => {
    const result = paginate(numberRows(25), 3, 10)

    expect(result).toEqual({ items: [21, 22, 23, 24, 25], page: 3, totalPages: 3 })
  })

  it('page di luar totalPages di-clamp ke halaman terakhir beserta itemnya', () => {
    const result = paginate(numberRows(25), 99, 10)

    expect(result).toEqual({ items: [21, 22, 23, 24, 25], page: 3, totalPages: 3 })
  })

  it('page di bawah 1 di-clamp ke 1', () => {
    const result = paginate(numberRows(25), 0, 10)

    expect(result).toEqual({ items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], page: 1, totalPages: 3 })
  })

  it('rows kosong selalu menghasilkan satu halaman kosong', () => {
    expect(paginate([], 5, 10)).toEqual({ items: [], page: 1, totalPages: 1 })
  })

  it('perubahan pageSize mengubah totalPages', () => {
    const result = paginate(numberRows(95), 1, 20)

    expect(result.page).toBe(1)
    expect(result.totalPages).toBe(5)
    expect(result.items).toHaveLength(20)
  })

  it('tidak memutasi array input', () => {
    const rows = Object.freeze(numberRows(25))
    const snapshot = [...rows]

    paginate(rows, 2, 10)

    expect(rows).toEqual(snapshot)
  })

  it('page NaN dan pageSize non-finite/0/negatif tidak menghasilkan NaN', () => {
    const rows = numberRows(25)
    const results = [
      paginate(rows, Number.NaN, 10),
      paginate(rows, 1, Number.NaN),
      paginate(rows, 1, 0),
      paginate(rows, 1, -10),
    ]

    for (const result of results) {
      expect(Number.isNaN(result.page)).toBe(false)
      expect(Number.isNaN(result.totalPages)).toBe(false)
      expect(result.items.some((item) => Number.isNaN(item))).toBe(false)
      expect(result.page).toBeGreaterThanOrEqual(1)
      expect(result.totalPages).toBeGreaterThanOrEqual(1)
    }
  })
})
