import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { actionLabel } from '../../../../lib/entriesModel.js'

// The ⋯ menu of one row of the organizer's panel (B3). `actions` come from entryActions, in menu
// order; each item calls onSelect(action, triggerElement), except „Skład drużyny”, which is a link to the team's
// page (RB4). The menu is fixed to the viewport, not to the row, so the table's horizontal scroll
// never clips it, and it opens upwards when there is no room below.

const GAP = 4
const EDGE = 16

const itemClass = 'block w-full text-left px-3.5 py-2.5 font-sans font-semibold text-[15px] leading-5 whitespace-nowrap ' +
  'text-apex-text-bright hover:bg-apex-surface-2 focus:bg-apex-surface-2 focus:outline-none no-underline'

export default function EntryMenu({ name, row, actions, isTeamRow = false, squadHref = null, onSelect }) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState(null)
  const trigger = useRef(null)
  const menu = useRef(null)
  const menuId = useId()

  function close({ focus = true } = {}) {
    setOpen(false)
    setPlace(null)
    if (focus) requestAnimationFrame(() => trigger.current?.focus())
  }

  // Under the trigger, right edges aligned, kept inside the viewport; above it when there is no
  // room below. Recomputed while the page scrolls or resizes, so the menu follows its row.
  function position() {
    if (!trigger.current || !menu.current) return
    const t = trigger.current.getBoundingClientRect()
    const m = menu.current.getBoundingClientRect()
    const below = t.bottom + GAP + m.height <= window.innerHeight - EDGE
    const top = below ? t.bottom + GAP : Math.max(EDGE, t.top - GAP - m.height)
    const left = Math.min(Math.max(EDGE, t.right - m.width), window.innerWidth - EDGE - m.width)
    setPlace((p) => (p && p.top === top && p.left === left ? p : { top, left }))
  }

  useLayoutEffect(() => {
    if (open) position()
  }, [open])

  // The first item takes the focus once the menu stands in its place.
  const placed = place != null
  useEffect(() => {
    if (placed) menu.current?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [placed])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (!menu.current?.contains(e.target) && !trigger.current?.contains(e.target)) close({ focus: false })
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
      const items = [...(menu.current?.querySelectorAll('[role="menuitem"]') ?? [])]
      if (!items.length) return
      e.preventDefault()
      const at = items.indexOf(document.activeElement)
      const next = e.key === 'Home' ? 0
        : e.key === 'End' ? items.length - 1
          : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
      items[next].focus()
    }
    const onMove = () => position()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open])

  if (!actions.length) return null

  // The trigger goes with the choice: whatever the action opens gives the focus back to it.
  function pick(action) {
    close({ focus: false })
    onSelect(action, trigger.current)
  }

  return (
    <>
      <button type="button" ref={trigger} aria-label={`Akcje — ${name}`} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} onClick={() => (open ? close() : setOpen(true))}
        className={`min-h-9 min-w-9 px-2 border font-mono font-bold text-base leading-none whitespace-nowrap ${
          open ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-bright text-apex-text-bright hover:border-apex-yellow-dim'}`}>
        <span aria-hidden="true">⋯</span>
      </button>
      {open && createPortal(
        <div ref={menu} id={menuId} role="menu" aria-label={`Akcje — ${name}`}
          style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
          className="fixed z-50 min-w-[220px] max-w-[calc(100vw-32px)] py-1 border border-apex-border-bright bg-apex-surface shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
          {actions.map((action) => (action === 'squad' && squadHref
            ? <a key={action} role="menuitem" tabIndex={-1} href={squadHref} className={itemClass} onClick={() => close({ focus: false })}>
                {actionLabel(action, row, { isTeamRow })}
              </a>
            : <button key={action} type="button" role="menuitem" tabIndex={-1} className={itemClass} onClick={() => pick(action)}>
                {actionLabel(action, row, { isTeamRow })}
              </button>))}
        </div>,
        document.body,
      )}
    </>
  )
}
