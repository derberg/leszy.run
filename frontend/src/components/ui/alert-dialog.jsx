import * as RadixAlertDialog from '@radix-ui/react-alert-dialog'
import { cn } from '../../lib/utils.js'
import { Button } from './button.jsx'

export const AlertDialog = RadixAlertDialog.Root
export const AlertDialogTrigger = RadixAlertDialog.Trigger

export function AlertDialogContent({ className, children, ...props }) {
  return (
    <RadixAlertDialog.Portal>
      <RadixAlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
      <RadixAlertDialog.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-full max-w-md border border-apex-border-mid bg-apex-surface shadow-xl p-6',
          className,
        )}
        {...props}
      >
        {children}
      </RadixAlertDialog.Content>
    </RadixAlertDialog.Portal>
  )
}

export function AlertDialogTitle({ className, ...props }) {
  return <RadixAlertDialog.Title className={cn('font-display text-2xl uppercase tracking-wider text-apex-text mb-2', className)} {...props} />
}

export function AlertDialogDescription({ className, ...props }) {
  return <RadixAlertDialog.Description className={cn('text-sm text-apex-muted mb-5', className)} {...props} />
}

export function AlertDialogFooter({ className, ...props }) {
  return <div className={cn('flex justify-end gap-2', className)} {...props} />
}

export const AlertDialogAction = RadixAlertDialog.Action
export const AlertDialogCancel = RadixAlertDialog.Cancel
