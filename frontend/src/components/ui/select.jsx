import * as RadixSelect from '@radix-ui/react-select'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '../../lib/utils.js'

export const Select = RadixSelect.Root
export const SelectValue = RadixSelect.Value

export function SelectTrigger({ className, children, ...props }) {
  return (
    <RadixSelect.Trigger
      className={cn(
        'flex h-9 w-full items-center justify-between border border-apex-border-mid bg-apex-surface-2 px-3 py-1 text-sm text-apex-text',
        'focus:outline-none focus:ring-1 focus:ring-apex-yellow focus:border-apex-yellow',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {children}
      <RadixSelect.Icon><ChevronDown size={14} className="text-apex-muted" /></RadixSelect.Icon>
    </RadixSelect.Trigger>
  )
}

export function SelectContent({ className, ...props }) {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        className={cn(
          'z-50 min-w-32 border border-apex-border-mid bg-apex-surface shadow-xl shadow-black/60',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          className,
        )}
        position="popper"
        sideOffset={4}
        {...props}
      >
        <RadixSelect.Viewport className="p-1">{props.children}</RadixSelect.Viewport>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  )
}

export function SelectItem({ className, children, ...props }) {
  return (
    <RadixSelect.Item
      className={cn(
        'relative flex cursor-pointer items-center px-6 py-1.5 text-sm text-apex-text',
        'hover:bg-apex-surface-3 hover:text-apex-yellow focus:bg-apex-surface-3 focus:outline-none',
        className,
      )}
      {...props}
    >
      <RadixSelect.ItemIndicator className="absolute left-1.5 text-apex-yellow">
        <Check size={12} />
      </RadixSelect.ItemIndicator>
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
    </RadixSelect.Item>
  )
}
