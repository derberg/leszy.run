import { useEffect, useRef, useState } from 'react'

// ↑/↓ on a squad (RB2, RB4). Moving a row moves its buttons in the DOM, which drops the focus, and
// at the end of the list the pressed button goes disabled. So the focus is put back after the
// render, on the same button or, at an end, on the other one, and a polite line says the new place.
export function useMoveFocus() {
  const [text, setText] = useState('')
  const pending = useRef(null)

  useEffect(() => {
    if (!pending.current) return
    const { key, dir } = pending.current
    pending.current = null
    const button = (d) => document.querySelector(`[data-move="${key}:${d}"]`)
    const same = button(dir)
    ;(same && !same.disabled ? same : button(-dir))?.focus()
  })

  return {
    moved(key, dir, announcement) {
      pending.current = { key, dir }
      setText(announcement)
    },
    status: <span className="sr-only" role="status" aria-live="polite" data-testid="move-status">{text}</span>,
  }
}
