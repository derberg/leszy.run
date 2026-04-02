import { useMemo } from 'react'

const MONTH_NAMES_PL = [
  'Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec',
  'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień',
]

const DAY_NAMES_DESKTOP = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Ndz']
const DAY_NAMES_MOBILE = ['P', 'W', 'Ś', 'C', 'P', 'S', 'N']

const LEGEND_ITEMS = [
  { label: 'Bieg / Uliczny', colorClass: 'bg-apex-cyan' },
  { label: 'Trail', colorClass: 'bg-[#4CAF50]' },
  { label: 'Ultra', colorClass: 'bg-red-500' },
  { label: 'OCR', colorClass: 'bg-[#FF9800]' },
  { label: 'Nordic', colorClass: 'bg-[#9C27B0]' },
  { label: 'Leszy.run', colorClass: 'bg-apex-yellow' },
]

/**
 * Determine the display color key for an event.
 * Priority: leszy > ultra > trail > ocr > nordic > default (cyan).
 * @param {object} event
 * @returns {'leszy'|'ultra'|'trail'|'ocr'|'nordic'|'default'}
 */
function getEventColorKey(event) {
  if (event.leszyrun_event_id) return 'leszy'
  const types = event.event_type || []
  if (types.includes('ultra')) return 'ultra'
  if (types.includes('trail')) return 'trail'
  if (types.includes('ocr')) return 'ocr'
  if (types.includes('nordic')) return 'nordic'
  return 'default'
}

/** Border-left class for desktop chips */
const CHIP_BORDER = {
  default: 'border-l-apex-cyan',
  trail: 'border-l-[#4CAF50]',
  ultra: 'border-l-red-500',
  ocr: 'border-l-[#FF9800]',
  nordic: 'border-l-[#9C27B0]',
  leszy: 'border-l-apex-yellow',
}

/** Extra bg class for leszy chips */
const CHIP_BG = {
  leszy: 'bg-apex-yellow/[0.04]',
}

/** Dot bg class for mobile */
const DOT_COLOR = {
  default: 'bg-apex-cyan',
  trail: 'bg-[#4CAF50]',
  ultra: 'bg-red-500',
  ocr: 'bg-[#FF9800]',
  nordic: 'bg-[#9C27B0]',
  leszy: 'bg-apex-yellow',
}

/**
 * CalendarGrid — month view of running events.
 *
 * @param {object} props
 * @param {Array} props.events - calendar_events from Supabase, already filtered
 * @param {string|null} props.selectedDate - 'YYYY-MM-DD' or null
 * @param {(dateStr: string) => void} props.onSelectDate
 * @param {Date} props.currentMonth - any date in the displayed month
 * @param {(newDate: Date) => void} props.onMonthChange
 */
export default function CalendarGrid({ events, selectedDate, onSelectDate, currentMonth, onMonthChange }) {
  const year = currentMonth.getFullYear()
  const month = currentMonth.getMonth()

  const todayStr = new Date().toISOString().split('T')[0]

  const prevMonth = new Date(year, month - 1, 1)
  const nextMonth = new Date(year, month + 1, 1)
  const prevMonthLabel = MONTH_NAMES_PL[prevMonth.getMonth()]
  const nextMonthLabel = MONTH_NAMES_PL[nextMonth.getMonth()]

  /** Group events by date string */
  const eventsByDate = useMemo(() => {
    const map = new Map()
    events.forEach(ev => {
      const key = ev.date
      if (!key) return
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(ev)
    })
    return map
  }, [events])

  /** Build grid cells: { day: number|null, dateStr: string|null } */
  const gridCells = useMemo(() => {
    const firstDay = new Date(year, month, 1)
    const lastDay = new Date(year, month + 1, 0)
    const startDow = (firstDay.getDay() + 6) % 7 // Mon=0
    const daysInMonth = lastDay.getDate()

    const cells = []

    // Empty cells before day 1
    for (let i = 0; i < startDow; i++) {
      cells.push({ day: null, dateStr: null })
    }

    // Days 1..daysInMonth
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      cells.push({ day: d, dateStr })
    }

    // Empty cells to complete the last week
    const remainder = cells.length % 7
    if (remainder > 0) {
      for (let i = 0; i < 7 - remainder; i++) {
        cells.push({ day: null, dateStr: null })
      }
    }

    return cells
  }, [year, month])

  const handlePrev = () => onMonthChange(prevMonth)
  const handleNext = () => onMonthChange(nextMonth)
  const handleToday = () => onMonthChange(new Date())

  return (
    <div>
      {/* Month navigation header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display font-extrabold text-xl md:text-2xl uppercase tracking-wide text-apex-text-bright">
          {MONTH_NAMES_PL[month]} {year}
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={handlePrev}
            className="font-sans text-[13px] text-apex-muted hover:text-apex-text-bright border border-apex-border hover:border-apex-border-mid px-2 py-1 rounded-none transition-colors"
          >
            <span className="hidden md:inline">{'\u25C0'} {prevMonthLabel}</span>
            <span className="md:hidden">{'\u25C0'}</span>
          </button>
          <button
            onClick={handleToday}
            className="font-sans text-[13px] text-apex-yellow-dim hover:text-apex-yellow border border-apex-border hover:border-apex-yellow-dim px-2 py-1 rounded-none transition-colors"
          >
            Dziś
          </button>
          <button
            onClick={handleNext}
            className="font-sans text-[13px] text-apex-muted hover:text-apex-text-bright border border-apex-border hover:border-apex-border-mid px-2 py-1 rounded-none transition-colors"
          >
            <span className="hidden md:inline">{nextMonthLabel} {'\u25B6'}</span>
            <span className="md:hidden">{'\u25B6'}</span>
          </button>
        </div>
      </div>

      {/* Color legend */}
      <div className="flex flex-wrap items-center gap-3 md:gap-4 mb-3">
        {LEGEND_ITEMS.map(item => (
          <div key={item.label} className="flex items-center gap-1.5">
            <span className={`w-4 h-[2px] ${item.colorClass} inline-block`} />
            <span className="font-sans text-[11px] text-apex-muted">{item.label}</span>
          </div>
        ))}
      </div>

      {/* Desktop grid (md+) */}
      <div className="hidden md:block">
        {/* Day name headers */}
        <div className="grid grid-cols-7">
          {DAY_NAMES_DESKTOP.map(name => (
            <div key={name} className="font-mono text-[10px] text-apex-muted uppercase tracking-widest text-center py-1.5">
              {name}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {gridCells.map((cell, i) => {
            if (cell.day === null) {
              return <div key={`empty-${i}`} className="bg-apex-bg border border-transparent min-h-[90px]" />
            }

            const isToday = cell.dateStr === todayStr
            const isSelected = cell.dateStr === selectedDate
            const dayEvents = eventsByDate.get(cell.dateStr) || []

            let borderClass = 'border-apex-border'
            if (isSelected) borderClass = 'border-apex-yellow'
            else if (isToday) borderClass = 'border-apex-yellow-dim'

            const bgClass = isSelected ? 'bg-apex-yellow/[0.03]' : 'bg-apex-surface'
            const dayNumClass = (isToday || isSelected) ? 'text-apex-yellow font-semibold' : 'text-apex-muted'

            return (
              <div
                key={cell.dateStr}
                onClick={() => onSelectDate(cell.dateStr)}
                className={`${bgClass} border ${borderClass} hover:border-apex-border-mid min-h-[90px] p-1.5 cursor-pointer transition-colors`}
              >
                <div className={`font-mono text-[11px] ${dayNumClass} mb-1`}>{cell.day}</div>
                {dayEvents.slice(0, 3).map((ev, j) => {
                  const colorKey = getEventColorKey(ev)
                  return (
                    <div
                      key={ev.id || j}
                      className={`text-[10px] font-sans px-1 py-0.5 mb-0.5 border-l-2 truncate text-apex-text ${CHIP_BORDER[colorKey]} ${CHIP_BG[colorKey] || ''}`}
                    >
                      {ev.name}
                    </div>
                  )
                })}
                {dayEvents.length > 3 && (
                  <div className="font-mono text-[9px] text-apex-yellow-dim pl-1">
                    +{dayEvents.length - 3} więcej
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Mobile grid (below md) */}
      <div className="md:hidden">
        {/* Day name headers */}
        <div className="grid grid-cols-7">
          {DAY_NAMES_MOBILE.map((name, i) => (
            <div key={`m-${i}`} className="font-mono text-[10px] text-apex-muted uppercase tracking-widest text-center py-1">
              {name}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {gridCells.map((cell, i) => {
            if (cell.day === null) {
              return <div key={`mempty-${i}`} className="bg-apex-bg min-h-[48px]" />
            }

            const isToday = cell.dateStr === todayStr
            const isSelected = cell.dateStr === selectedDate
            const dayEvents = eventsByDate.get(cell.dateStr) || []

            const dayNumClass = (isToday || isSelected) ? 'text-apex-yellow font-semibold' : 'text-apex-muted'
            const selectedStyles = isSelected
              ? 'outline outline-1 outline-apex-yellow -outline-offset-1 bg-apex-surface-2'
              : 'bg-apex-surface'

            return (
              <div
                key={cell.dateStr}
                onClick={() => onSelectDate(cell.dateStr)}
                className={`${selectedStyles} text-center py-1.5 px-0.5 min-h-[48px] cursor-pointer transition-colors`}
              >
                <div className={`font-mono text-[11px] ${dayNumClass} mb-1`}>{cell.day}</div>
                {dayEvents.length > 0 && (
                  <div className="flex gap-0.5 flex-wrap justify-center">
                    {dayEvents.slice(0, 6).map((ev, j) => {
                      const colorKey = getEventColorKey(ev)
                      return (
                        <span
                          key={ev.id || j}
                          className={`w-[5px] h-[5px] rounded-full ${DOT_COLOR[colorKey]}`}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Mobile legend (compact, centered) */}
        <div className="flex flex-wrap items-center justify-center gap-2.5 mt-3">
          {LEGEND_ITEMS.map(item => (
            <div key={item.label} className="flex items-center gap-1">
              <span className={`w-3 h-[2px] ${item.colorClass} inline-block`} />
              <span className="font-sans text-[10px] text-apex-muted">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
