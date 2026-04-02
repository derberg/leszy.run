import { forwardRef, useEffect, useRef } from 'react'
import EventRow from './EventRow.jsx'

const DAY_NAMES = ['Niedziela', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota']
const MONTH_NAMES_GENITIVE = [
  'Stycznia', 'Lutego', 'Marca', 'Kwietnia', 'Maja', 'Czerwca',
  'Lipca', 'Sierpnia', 'Września', 'Października', 'Listopada', 'Grudnia'
]

function formatPolishDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  const dayName = DAY_NAMES[d.getDay()]
  const day = d.getDate()
  const month = MONTH_NAMES_GENITIVE[d.getMonth()]
  const year = d.getFullYear()
  return `${dayName}, ${day} ${month} ${year}`
}

function wydarzeniaCount(n) {
  if (n === 1) return '1 wydarzenie'
  if (n >= 2 && n <= 4) return `${n} wydarzenia`
  return `${n} wydarzeń`
}

const CalendarDetailPanel = forwardRef(function CalendarDetailPanel({ date, events }, ref) {
  const innerRef = useRef(null)
  const panelRef = ref || innerRef

  useEffect(() => {
    if (panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [date])

  return (
    <div
      ref={panelRef}
      className="bg-apex-surface border border-apex-border border-l-[3px] border-l-apex-yellow animate-slide-down"
      style={{
        animation: 'slideDown 200ms ease-out',
      }}
    >
      <style>{`
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Header */}
      <div className="px-4 py-3 border-b border-apex-border flex justify-between items-center">
        <span className="font-mono text-[11px] font-semibold tracking-wide uppercase text-apex-yellow">
          {formatPolishDate(date)}
        </span>
        <span className="font-mono text-[11px] text-apex-muted">
          {wydarzeniaCount(events.length)}
        </span>
      </div>

      {/* Event list */}
      <div>
        {events.length > 0 ? (
          events.map(ev => <EventRow key={ev.id} event={ev} />)
        ) : (
          <div className="text-apex-muted text-sm py-6 text-center">
            Brak wydarzeń w tym dniu.
          </div>
        )}
      </div>
    </div>
  )
})

export default CalendarDetailPanel
