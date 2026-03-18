import { cn } from '../../lib/utils.js'

export function Card({ className, ...props }) {
  return (
    <div
      className={cn(
        'relative border border-apex-border bg-apex-surface overflow-hidden',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }) {
  return <div className={cn('border-b border-apex-border px-4 py-3', className)} {...props} />
}

export function CardTitle({ className, ...props }) {
  return <h3 className={cn('font-display text-xl tracking-wider text-apex-text-bright uppercase', className)} {...props} />
}

export function CardContent({ className, ...props }) {
  return <div className={cn('p-4', className)} {...props} />
}

export function CardFooter({ className, ...props }) {
  return <div className={cn('border-t border-apex-border px-4 py-3', className)} {...props} />
}
