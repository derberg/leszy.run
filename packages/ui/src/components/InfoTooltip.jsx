import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

const MARGIN = 8
const GAP = 6

/**
 * A "?" button that reveals an explanation popup.
 *
 * The popup is rendered through a portal into <body> with `position: fixed`,
 * NOT as an absolutely-positioned child. That is load-bearing: the results
 * table lives inside an `overflow-x-auto` wrapper, which is a clipping context —
 * an absolutely-positioned popup on a right-hand column (Brutto, Status) gets
 * cut off by it no matter how high its z-index is. A fixed-position portal
 * escapes every ancestor's overflow and stacking context.
 *
 * @param {string} label - accessible description of what is being explained
 * @param {'left'|'right'} [align] - preferred horizontal anchor edge; the popup
 *   is clamped into the viewport either way, so this only decides which side it
 *   prefers when there is room on both.
 */
export function InfoTooltip({ label, align = 'left', children }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)

  const place = useCallback(() => {
    const btn = btnRef.current
    const pop = popRef.current
    if (!btn || !pop) return
    const b = btn.getBoundingClientRect()
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = align === 'right' ? b.right - w : b.left
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - w - MARGIN))

    // Below the button by default; flip above when it would run off the bottom
    // and there is more room up there.
    let top = b.bottom + GAP
    if (top + h > vh - MARGIN && b.top - GAP - h > MARGIN) top = b.top - GAP - h
    top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - h - MARGIN))

    setPos({ top, left })
  }, [align])

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = e => { if (e.key === 'Escape') close() }
    const onPointer = e => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return
      close()
    }
    // Fixed popups don't follow the page, so dismiss instead of chasing scroll.
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [open])

  return (
    <span className="inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        aria-label={`Wyjaśnienie: ${label}`}
        aria-expanded={open}
        className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full border border-apex-muted text-apex-muted text-[10px] hover:border-apex-yellow hover:text-apex-yellow cursor-pointer leading-none align-middle"
      >
        ?
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: pos ? `${pos.top}px` : 0,
            left: pos ? `${pos.left}px` : 0,
            visibility: pos ? 'visible' : 'hidden',
          }}
          className="z-[100] w-[min(17rem,calc(100vw-1rem))] text-left bg-apex-bg border border-apex-yellow p-2.5 text-xs font-normal normal-case tracking-normal text-apex-text shadow-lg whitespace-normal"
        >
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}
