import type { HTMLAttributes, ReactNode } from 'react'

function mergeClasses(...classes: Array<string | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

/**
 * Kartu permukaan — memakai kelas global `.card` dari `globals.css`
 * (border, radius, shadow) supaya tidak ada deklarasi style ganda.
 */
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={mergeClasses('card', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={mergeClasses('flex items-center justify-between gap-4 px-5 pt-5', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardTitle({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLHeadingElement>): ReactNode {
  return (
    <h3 className={mergeClasses('text-base font-semibold text-ink', className)} {...rest}>
      {children}
    </h3>
  )
}

export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={mergeClasses('p-5', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={mergeClasses(
        'flex flex-wrap items-center justify-end gap-3 border-t border-border-light px-5 py-4',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}
