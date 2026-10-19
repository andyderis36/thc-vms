export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const

export const DEFAULT_PAGE_SIZE = 10

export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number]
