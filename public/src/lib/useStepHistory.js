import { useEffect, useRef } from 'react'
import { confirmLeave } from './leaveGuard.js'

// The steps of a registration form as browser history, so a phone's Back goes to the previous
// step. Each step is an entry, in history.state and never in the address (the router's own keys
// stay in the entry). Shared by the group form (Zapis.jsx) and the team form (TeamSignup.jsx).
//
// `id` names the step on screen. `state` is what restores it, handed back to `onRestore`.
// `onEnter` runs when a step opens, Back and Forward included. While `guard` is on, the entry
// under the first step is the way out: it asks first, since beforeunload does not fire for an
// in-app page, and passes on to the page before the form. The router hears every popstate, and
// none of these entries changes the address.
export function useStepHistory({ id, state, guard, onEnter, onRestore }) {
  // This form's entries; an older form's in the same tab held another draft.
  const formId = useRef(Math.random().toString(36).slice(2))
  // The step last on screen and what restores it.
  const shown = useRef(undefined)
  const shownState = useRef(null)
  // The step on its way to the screen came from Back or Forward: it has an entry already.
  const restoring = useRef(false)
  // The entry under the first step has become the way out.
  const exitEntry = useRef(false)
  const restore = useRef(onRestore)
  useEffect(() => { restore.current = onRestore })

  useEffect(() => {
    const before = shown.current
    const beforeState = shownState.current
    shown.current = id
    shownState.current = state
    const entry = { ...window.history.state, zapis: { form: formId.current, id, ...state } }
    if (before === undefined) window.history.replaceState(entry, '')
    if (before === undefined || id === before) return
    if (restoring.current) {
      restoring.current = false
    } else {
      if (guard && !exitEntry.current) {
        exitEntry.current = true
        window.history.replaceState({ ...entry, zapis: { form: formId.current, exit: true } }, '')
        window.history.pushState({ ...entry, zapis: { form: formId.current, id: before, ...beforeState } }, '')
      }
      window.history.pushState(entry, '')
    }
    onEnter?.()
  }, [id])

  useEffect(() => {
    const onPop = (e) => {
      const s = e.state?.zapis
      if (s?.form !== formId.current) return
      if (s.exit) {
        if (!guard || confirmLeave()) window.history.back()
        else window.history.forward()
        return
      }
      restoring.current = s.id !== shown.current
      restore.current(s)
    }
    // The browser would put a step back at its old scroll, over the top the step opens at.
    const scrolling = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    window.addEventListener('popstate', onPop)
    return () => {
      window.history.scrollRestoration = scrolling
      window.removeEventListener('popstate', onPop)
    }
  }, [guard])
}

/** A refusal landed on a card, whose step is on screen now: focus its first invalid field. */
export function focusCardError(key) {
  const root = document.querySelector(`[data-card-key="${key}"]`)
  if (!root) return
  const target = root.querySelector('[aria-invalid="true"], [data-invalid="true"] button') ?? root
  target.focus({ preventScroll: true })
  // From the top, so „Popraw dane: …” is read too, unless the field is below the fold then.
  window.scrollTo({ top: 0, behavior: 'instant' })
  if (target.getBoundingClientRect().bottom > window.innerHeight) target.scrollIntoView({ block: 'center' })
}
