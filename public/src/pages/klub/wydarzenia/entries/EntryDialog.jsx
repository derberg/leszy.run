import { useEffect, useId, useRef } from 'react'
import { btnGhost } from '../../settingsUi.js'

// The frame every dialog of the entries panel shares: a modal role="dialog" named by its title,
// the focus kept inside it while it is open, Escape and „Anuluj” closing it unless a request is in
// flight. The page gives the focus back to the ⋯ that opened it (Zgloszenia's closeDialog).

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export const dialogTitle = 'font-display font-extrabold text-[24px] sm:text-[28px] uppercase leading-none text-apex-text-bright break-words'
export const dialogLabel = 'block font-mono text-xs uppercase tracking-wide text-apex-muted mb-1.5'
export const dialogInput = 'w-full min-w-0 bg-apex-bg border border-apex-border-mid text-apex-text-bright font-sans text-base font-medium py-2 px-3 outline-none focus:border-apex-yellow-dim disabled:opacity-60'

export function FieldMessage({ id, message }) {
  if (!message) return null
  return <p id={id} className="mt-1 text-apex-red font-sans text-sm">{message}</p>
}

/**
 * @param {{ title: string, subtitle?: string, busy: boolean, onClose: () => void, error?: string|null,
 *   actions: import('react').ReactNode, children?: import('react').ReactNode, testId: string, wide?: boolean,
 *   closeLabel?: string }} props
 */
export default function EntryDialog({ title, subtitle, busy, onClose, error, actions, children, testId, wide = false, closeLabel = 'Anuluj' }) {
  const titleId = useId()
  const box = useRef(null)
  const state = useRef({ busy, onClose })
  state.current = { busy, onClose }

  // The first field takes the focus, or the dialog itself when it has none.
  useEffect(() => {
    const first = box.current?.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
    ;(first ?? box.current)?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (!state.current.busy) state.current.onClose()
        return
      }
      if (e.key !== 'Tab' || !box.current) return
      const items = [...box.current.querySelectorAll(FOCUSABLE)]
      if (!items.length) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const inside = box.current.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-black/60 px-4 pt-20 pb-10 sm:pb-16">
      <div ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}
        className={`mx-auto w-full ${wide ? 'max-w-[640px]' : 'max-w-[480px]'} border border-apex-border-bright bg-apex-surface p-5 sm:p-6 flex flex-col gap-4 outline-none min-w-0`}>
        <div className="flex flex-col gap-1.5 min-w-0">
          <h2 id={titleId} className={dialogTitle}>{title}</h2>
          {subtitle && <p className="font-sans text-base text-apex-text break-words">{subtitle}</p>}
        </div>
        {children}
        {error && <p role="alert" className="text-apex-red font-sans text-sm" data-testid="dialog-error">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2.5">
          <button type="button" className={btnGhost} disabled={busy} onClick={onClose}>{closeLabel}</button>
          {actions}
        </div>
      </div>
    </div>
  )
}
