import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'

// A „⋯” button opening a menu of actions: the organizer's row menu (B3, EntryMenu) and the runner's
// per-person menu („Moje zapisy”, RA5; EntryActions) and a „Moje zapisy” card's links. Each item is
// { key, label, onSelect?, to?, testId? }: `to` makes it a link (a real <a>), otherwise
// onSelect(triggerElement) runs after the menu closes, so whatever the action opens can give the
// focus back to the trigger. { key, separator: true } draws a thin divider between groups; it is
// not an item, so the keyboard skips it. The menu is fixed to the
// viewport, never to its row or card, so no `overflow` clips it; it sits under the trigger with the
// right edges aligned, inside the viewport, and opens upwards when there is no room below.
// Escape closes it, ArrowUp/ArrowDown/Home/End move between items, a click outside closes it.
// `text` replaces the „⋯” with a labelled button (`triggerClass` styles it): B3's „Eksport dodatków”.
// Tab (and Shift+Tab) closes it and moves on from the trigger, as the WAI-ARIA menu pattern asks:
// the menu is portaled to the end of <body>, so the focus goes back to the trigger first and the
// browser's own Tab then moves to the element after (or before) it.

const GAP = 4
const EDGE = 16

const ITEM = 'block w-full text-left px-3.5 py-2.5 font-sans text-[15px] leading-5 whitespace-nowrap ' +
  'text-apex-text-bright hover:bg-apex-surface-2 focus:bg-apex-surface-2 focus:outline-none no-underline'

const TRIGGER = {
  // B3: a row of a table.
  md: 'min-h-9 min-w-9 px-2',
  // „Moje zapisy”, RA5: a person's line.
  sm: 'h-7 min-w-8 px-1.5',
}

/**
 * @param {{ label: string, items: Array<{ key: string, label?: string, onSelect?: (trigger: HTMLElement) => void,
 *   to?: string, testId?: string, separator?: boolean }>, size?: 'md' | 'sm', itemWeight?: string, testId?: string,
 *   text?: string, triggerClass?: string, disabled?: boolean }} p
 */
export default function ActionMenu({ label, items, size = 'md', itemWeight = 'font-semibold', testId, text, triggerClass, disabled = false }) {
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
  // room below. Recomputed while the page scrolls or resizes, so the menu follows its trigger.
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
      if (e.key === 'Tab') {
        trigger.current?.focus()
        close({ focus: false })
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
      const all = [...(menu.current?.querySelectorAll('[role="menuitem"]') ?? [])]
      if (!all.length) return
      e.preventDefault()
      const at = all.indexOf(document.activeElement)
      const next = e.key === 'Home' ? 0
        : e.key === 'End' ? all.length - 1
          : e.key === 'ArrowDown' ? (at + 1) % all.length : (at - 1 + all.length) % all.length
      all[next].focus()
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

  if (!items.some((item) => !item.separator)) return null

  function pick(item) {
    close({ focus: false })
    item.onSelect?.(trigger.current)
  }

  const itemClass = `${ITEM} ${itemWeight}`
  return (
    <>
      <button type="button" ref={trigger} aria-label={text ? undefined : label} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} onClick={() => (open ? close() : setOpen(true))} data-testid={testId}
        disabled={disabled}
        className={text ? triggerClass : `${TRIGGER[size]} shrink-0 inline-flex items-center justify-center border font-mono font-bold text-base leading-none whitespace-nowrap ${
          open ? 'border-apex-yellow text-apex-yellow' : 'border-apex-border-bright text-apex-text-bright hover:border-apex-yellow-dim'}`}>
        {text ?? <span aria-hidden="true">⋯</span>}
      </button>
      {open && createPortal(
        <div ref={menu} id={menuId} role="menu" aria-label={label}
          style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
          className="fixed z-50 min-w-[220px] max-w-[calc(100vw-32px)] py-1 border border-apex-border-bright bg-apex-surface">
          {items.map((item) => (item.separator
            ? <div key={item.key} role="separator" className="my-1 border-t border-apex-border" />
            : item.to
            ? <Link key={item.key} role="menuitem" tabIndex={-1} to={item.to} className={itemClass} data-testid={item.testId}
                onClick={() => close({ focus: false })}>
                {item.label}
              </Link>
            : <button key={item.key} type="button" role="menuitem" tabIndex={-1} className={itemClass} data-testid={item.testId}
                onClick={() => pick(item)}>
                {item.label}
              </button>))}
        </div>,
        document.body,
      )}
    </>
  )
}
