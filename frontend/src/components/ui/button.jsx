import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils.js'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 text-sm font-bold tracking-widest uppercase transition-all duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-40 cursor-pointer',
  {
    variants: {
      variant: {
        default: [
          'border border-apex-yellow text-apex-yellow bg-transparent',
          'hover:bg-apex-yellow hover:text-black',
          'focus-visible:ring-apex-yellow',
        ],
        destructive: [
          'border border-apex-red text-apex-red bg-transparent',
          'hover:bg-apex-red hover:text-white',
          'focus-visible:ring-apex-red',
        ],
        outline: [
          'border border-apex-border-bright text-apex-text bg-transparent',
          'hover:border-apex-yellow hover:text-apex-yellow',
          'focus-visible:ring-apex-border-bright',
        ],
        ghost: [
          'text-apex-muted bg-transparent border border-transparent',
          'hover:text-apex-text hover:border-apex-border-mid',
          'focus-visible:ring-apex-border-mid',
        ],
        secondary: [
          'border border-apex-cyan text-apex-cyan bg-transparent',
          'hover:bg-apex-cyan hover:text-black',
          'focus-visible:ring-apex-cyan',
        ],
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-7 px-3 text-xs',
        lg: 'h-11 px-6 text-base',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
