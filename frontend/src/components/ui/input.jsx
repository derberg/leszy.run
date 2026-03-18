import { cn } from '../../lib/utils.js'

export function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        'h-9 w-full border border-apex-border-mid bg-apex-surface-2 px-3 py-1',
        'text-sm text-apex-text placeholder:text-apex-muted font-sans',
        'focus:outline-none focus:ring-1 focus:ring-apex-yellow focus:border-apex-yellow',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    />
  )
}
