import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils.js'

export const Dialog = RadixDialog.Root
export const DialogTrigger = RadixDialog.Trigger

export function DialogContent({ className, children, ...props }) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <RadixDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-full max-w-lg border border-apex-border-mid bg-apex-surface shadow-2xl shadow-black/80',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
        <RadixDialog.Close className="absolute right-3 top-3 text-apex-muted hover:text-apex-yellow transition-colors focus:outline-none">
          <X size={18} />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
}

export function DialogHeader({ className, ...props }) {
  return <div className={cn('border-b border-apex-border px-5 py-4', className)} {...props} />
}

export function DialogTitle({ className, ...props }) {
  return <RadixDialog.Title className={cn('font-display text-2xl tracking-wider uppercase text-apex-text-bright', className)} {...props} />
}

export function DialogDescription({ className, ...props }) {
  return <RadixDialog.Description className={cn('mt-1 text-sm text-apex-muted', className)} {...props} />
}

export function DialogFooter({ className, ...props }) {
  return <div className={cn('flex justify-end gap-2 border-t border-apex-border px-5 py-4', className)} {...props} />
}

export function DialogBody({ className, ...props }) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}
