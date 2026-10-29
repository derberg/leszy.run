// Small shared pieces of the organizer wizard's steps.

export function FieldError({ message }) {
  if (!message) return null
  return <p className="text-apex-red font-sans text-sm mt-1.5">{message}</p>
}

export function MonoHint({ children }) {
  return <div className="font-mono text-xs uppercase tracking-wide text-apex-muted mt-1.5">{children}</div>
}

/** Field errors the server returned for this section's last failed save. */
export function sectionErrors(saveState, section) {
  const e = saveState?.error
  return e?.section === section && e.fields ? e.fields : {}
}

// Compact input for table cells and short fields.
// Width comes from the caller (w-full or a fixed w-[…]).
export const cellInput = 'min-w-0 h-10 bg-apex-bg border border-apex-border-mid text-apex-text-bright font-sans text-base font-medium px-2.5 outline-none focus:border-apex-yellow-dim disabled:opacity-60'
export const thClass = 'font-mono text-xs font-medium uppercase text-apex-muted text-left px-2.5 py-2 border-b border-apex-border-mid whitespace-nowrap'
export const tdClass = 'px-2.5 py-2 border-b border-apex-border align-top'
export const cardClass = 'border border-apex-border-mid bg-apex-surface p-4 sm:p-5 flex flex-col gap-3.5 min-w-0'
export const cardTitle = 'font-display font-extrabold text-[22px] uppercase leading-none text-apex-text-bright'
export const monoLabel = 'font-mono text-xs uppercase tracking-wide text-apex-muted'

/** The „wkrótce” tag on a control that is not built yet. */
export function Soon() {
  return <span className="font-mono text-[10px] uppercase tracking-wide text-apex-muted">wkrótce</span>
}

/** One button of a segmented choice. */
export function Seg({ on, className = '', ...props }) {
  return (
    <button type="button" aria-pressed={!!on} {...props}
      className={`whitespace-nowrap min-h-9 px-3 border font-sans font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed ${
        on ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-bright text-apex-muted hover:text-apex-text-bright'} ${className}`} />
  )
}

/** 🔒 on a control locked after publish. */
export function Lock({ title }) {
  return <span role="img" aria-label={title} title={title} className="text-sm">🔒</span>
}
