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
