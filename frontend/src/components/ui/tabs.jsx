import * as RadixTabs from '@radix-ui/react-tabs'
import { cn } from '../../lib/utils.js'

export const Tabs = RadixTabs.Root

export function TabsList({ className, ...props }) {
  return (
    <RadixTabs.List
      className={cn('flex border-b border-apex-border bg-transparent', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'px-4 py-2.5 text-sm font-bold text-apex-muted uppercase tracking-widest border-b-2 border-transparent',
        'hover:text-apex-text transition-colors',
        'data-[state=active]:border-apex-yellow data-[state=active]:text-apex-yellow',
        'focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }) {
  return <RadixTabs.Content className={cn('pt-4', className)} {...props} />
}
