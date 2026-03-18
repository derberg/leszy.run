import { cn } from '../../lib/utils.js'

export function Badge({ className, children, ...props }) {
  return (
    <span
      className={cn(
        'inline-flex items-center border px-2 py-0.5 text-xs font-bold uppercase tracking-widest font-mono',
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}
