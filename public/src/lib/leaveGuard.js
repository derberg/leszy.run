import { useEffect } from 'react'

// The group form lives in React memory only (groupDraft.js): a reload, a closed tab or a link
// away loses every person on it. `useLeaveGuard(on)` asks the browser to confirm before the
// page unloads; `releaseLeaveGuard()` lifts it just before the page leaves on purpose (the
// redirect to dpay), so the payment is never held up by the browser's dialog.
// `confirmLeave()` is for in-app links, which beforeunload never sees.

let released = false

const onBeforeUnload = (e) => {
  if (released) return
  e.preventDefault()
  e.returnValue = ''
}

export function useLeaveGuard(on) {
  useEffect(() => {
    if (!on) return undefined
    released = false
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [on])
}

export function releaseLeaveGuard() {
  released = true
  window.removeEventListener('beforeunload', onBeforeUnload)
}

export const LEAVE_QUESTION = 'Opuścić formularz? Wpisane dane osób przepadną.'

export function confirmLeave() {
  return window.confirm(LEAVE_QUESTION)
}
