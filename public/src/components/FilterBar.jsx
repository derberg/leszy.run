import { useState, useRef, useEffect } from 'react'

const EVENT_TYPES = [
  { value: 'uliczny', label: 'Bieg uliczny' },
  { value: 'trail', label: 'Przełajowy / Trail' },
  { value: 'ultra', label: 'Ultramaraton' },
  { value: 'nordic walking', label: 'Nordic Walking' },
  { value: 'ocr', label: 'OCR' },
  { value: 'nocny', label: 'Bieg nocny' },
  { value: 'charytatywny', label: 'Charytatywny' },
  { value: 'dzieci', label: 'Dla dzieci' },
]

const VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie', 'Wielkopolskie', 'Zachodniopomorskie',
]

const DISTANCES = [
  { value: '0-5000', label: 'do 5 km' },
  { value: '5000-10000', label: '5-10 km' },
  { value: '10000-21100', label: '10-21 km' },
  { value: '21100-21100', label: 'Półmaraton' },
  { value: '42200-42200', label: 'Maraton' },
  { value: '50000-999999', label: 'Ultra (50+ km)' },
]

const TIME_RANGES = [
  { value: '', label: 'Najbliższe' },
  { value: 'week', label: 'Ten tydzień' },
  { value: 'month', label: 'Ten miesiąc' },
  { value: 'next-month', label: 'Następny miesiąc' },
  { value: 'year', label: 'Cały rok' },
  { value: 'next-year', label: 'Następny rok' },
  { value: 'after', label: 'Od miesiąca...' },
]

const MONTH_NAMES = [
  'Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec',
  'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień',
]

const selectClass = "bg-apex-surface border border-apex-border text-apex-text font-sans text-sm font-semibold py-2.5 pl-3.5 pr-8 outline-none appearance-none cursor-pointer focus:border-apex-yellow-dim w-full md:w-auto"

const SNAP_POINTS = [10, 25, 50, 100, 150, 200]
const SNAP_THRESHOLD = 0.08 * (200 - 5)

function snapRadius(value) {
  for (const snap of SNAP_POINTS) {
    if (Math.abs(value - snap) <= SNAP_THRESHOLD) return snap
  }
  return value
}

function activeFilterCount(filters, userLocation) {
  let count = 0
  if (filters.type.length) count++
  if (filters.voivodeship.length) count++
  if (filters.distance.length) count++
  if (filters.timeRange) count++
  if (userLocation) count++
  return count
}

function MultiSelect({ options, selected, onChange, allLabel, ariaLabel }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const toggle = (value) => {
    const next = selected.includes(value)
      ? selected.filter(v => v !== value)
      : [...selected, value]
    onChange(next)
  }

  const label = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? options.find(o => o.value === selected[0])?.label || selected[0]
      : `${allLabel.split(':')[0]}: ${selected.length} wybranych`

  return (
    <div className="relative w-full md:w-auto" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`${selectClass} text-left w-full md:w-auto flex items-center justify-between gap-2 ${selected.length > 0 ? 'border-apex-yellow-dim text-apex-text-bright' : ''}`}
        aria-label={ariaLabel}
        aria-expanded={open}
      >
        <span className="truncate">{label}</span>
        <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-full md:w-64 max-h-72 overflow-y-auto bg-apex-surface border border-apex-border z-50 shadow-lg">
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full text-left px-3.5 py-2 text-xs font-mono text-apex-yellow hover:bg-apex-surface-2 border-b border-apex-border"
            >
              Wyczyść filtr
            </button>
          )}
          {options.map(opt => (
            <button
              type="button"
              key={opt.value}
              onClick={() => toggle(opt.value)}
              className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-apex-surface-2 transition-colors w-full text-left"
            >
              <span className={`w-4 h-4 flex-shrink-0 border ${selected.includes(opt.value) ? 'bg-apex-yellow border-apex-yellow' : 'border-apex-border-mid'} flex items-center justify-center`}>
                {selected.includes(opt.value) && (
                  <svg className="w-3 h-3 text-apex-ink" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </span>
              <span className="font-sans text-sm text-apex-text">{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function getAfterMonths() {
  const now = new Date()
  const months = []
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const val = `after-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`
    months.push({ value: val, label })
  }
  return months
}

function TimeRangeSelect({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [submenuOpen, setSubmenuOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
        setSubmenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const isAfter = value.startsWith('after-') && value !== 'after'
  const afterMonths = getAfterMonths()

  const getLabel = () => {
    if (isAfter) {
      const m = afterMonths.find(m => m.value === value)
      return m ? `Od: ${m.label}` : 'Od miesiąca...'
    }
    const found = TIME_RANGES.find(t => t.value === value)
    return found ? (value === '' ? 'Kiedy: Najbliższe' : found.label) : 'Kiedy: Najbliższe'
  }

  const select = (val) => {
    onChange(val)
    setOpen(false)
    setSubmenuOpen(false)
  }

  const isActive = value !== ''

  return (
    <div className="relative w-full md:w-auto" ref={ref}>
      <button
        type="button"
        onClick={() => { setOpen(!open); if (open) setSubmenuOpen(false) }}
        className={`${selectClass} text-left w-full md:w-auto flex items-center justify-between gap-2 ${isActive ? 'border-apex-yellow-dim text-apex-text-bright' : ''}`}
        aria-label="Filtruj po czasie"
        aria-expanded={open}
      >
        <span className="truncate">{getLabel()}</span>
        <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-full md:w-64 max-h-[400px] overflow-y-auto bg-apex-surface border border-apex-border z-50 shadow-lg">
          {TIME_RANGES.filter(t => t.value !== 'after').map(t => (
            <button
              type="button"
              key={t.value}
              onClick={() => select(t.value)}
              className={`flex items-center gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-apex-surface-2 transition-colors w-full text-left ${value === t.value ? 'text-apex-yellow' : 'text-apex-text'}`}
            >
              <span className={`w-1.5 h-1.5 flex-shrink-0 rounded-full ${value === t.value ? 'bg-apex-yellow' : 'bg-transparent'}`} />
              <span className="font-sans text-sm">{t.label}</span>
            </button>
          ))}

          {/* "Od miesiąca" with expandable submenu */}
          <button
            type="button"
            onClick={() => setSubmenuOpen(!submenuOpen)}
            className={`flex items-center justify-between px-3.5 py-2.5 cursor-pointer hover:bg-apex-surface-2 transition-colors w-full text-left border-t border-apex-border ${isAfter ? 'text-apex-yellow' : 'text-apex-text'}`}
          >
            <span className="flex items-center gap-3">
              <span className={`w-1.5 h-1.5 flex-shrink-0 rounded-full ${isAfter ? 'bg-apex-yellow' : 'bg-transparent'}`} />
              <span className="font-sans text-sm">Od miesiąca...</span>
            </span>
            <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${submenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none">
              <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          {submenuOpen && (
            <div className="bg-apex-bg/50">
              {afterMonths.map(m => (
                <button
                  type="button"
                  key={m.value}
                  onClick={() => select(m.value)}
                  className={`flex items-center gap-3 pl-8 pr-3.5 py-2 cursor-pointer hover:bg-apex-surface-2 transition-colors w-full text-left ${value === m.value ? 'text-apex-yellow' : 'text-apex-text'}`}
                >
                  <span className={`w-1.5 h-1.5 flex-shrink-0 rounded-full ${value === m.value ? 'bg-apex-yellow' : 'bg-transparent'}`} />
                  <span className="font-sans text-sm">{m.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function FilterBar({ filters, onChange, view, onViewChange, userLocation, radius, onLocationRequest, onLocationClear, onRadiusChange }) {
  const [open, setOpen] = useState(false)
  const update = (key, value) => onChange({ ...filters, [key]: value })
  const count = activeFilterCount(filters, userLocation)

  return (
    <div className="sticky top-14 z-40 bg-apex-bg/92 backdrop-blur-md border-b border-apex-border py-4">
      <div className="max-w-[1200px] mx-auto px-6 flex flex-col gap-3">
        {/* Row 1: Search + Filtry toggle (mobile) / Search + Blisko mnie + Lista/Mapa (desktop) */}
        <div className="flex gap-3 items-center">
          <input
            type="text"
            placeholder="Szukaj po nazwie, miejscu..."
            value={filters.search}
            onChange={(e) => update('search', e.target.value)}
            className="flex-1 min-w-0 md:max-w-[260px] bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-[15px] font-medium py-2.5 px-4 outline-none focus:border-apex-yellow-dim placeholder:text-apex-muted"
            aria-label="Szukaj wydarzeń"
          />
          <button
            onClick={() => setOpen(!open)}
            className={`md:hidden flex-shrink-0 font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border transition-all ${open || count > 0 ? 'bg-apex-yellow text-apex-ink border-apex-yellow' : 'bg-apex-surface border-apex-border text-apex-muted'}`}
            aria-expanded={open}
            aria-label="Filtry"
          >
            Filtry{count > 0 ? ` (${count})` : ''}
          </button>

          {!userLocation ? (
            <button
              onClick={onLocationRequest}
              className="hidden md:block font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all flex-shrink-0"
              aria-label="Pokaż wydarzenia blisko mnie"
            >
              📍 Blisko mnie
            </button>
          ) : (
            <button
              onClick={onLocationClear}
              className="hidden md:block font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 bg-apex-yellow text-apex-ink border border-apex-yellow transition-all flex-shrink-0"
              aria-label="Wyłącz filtr lokalizacji"
            >
              📍 Twoja lokalizacja ✕
            </button>
          )}

          <div className="hidden md:flex border border-apex-border overflow-hidden flex-shrink-0 ml-auto" role="group" aria-label="Widok">
            <button onClick={() => onViewChange('list')}
              className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border-r border-apex-border transition-all ${view === 'list' ? 'bg-apex-yellow text-apex-ink' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
              Lista
            </button>
            <button onClick={() => onViewChange('calendar')}
              className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border-r border-apex-border transition-all ${view === 'calendar' ? 'bg-apex-yellow text-apex-ink' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
              Kalendarz
            </button>
            <button onClick={() => onViewChange('map')}
              className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 transition-all ${view === 'map' ? 'bg-apex-yellow text-apex-ink' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
              Mapa
            </button>
          </div>
        </div>

        {/* Mobile row 2: Blisko mnie + Lista/Mapa (always visible) */}
        <div className="flex md:hidden gap-3 items-center">
          {!userLocation ? (
            <button
              onClick={onLocationRequest}
              className="font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all flex-shrink-0"
              aria-label="Pokaż wydarzenia blisko mnie"
            >
              📍 Blisko mnie
            </button>
          ) : (
            <button
              onClick={onLocationClear}
              className="font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 bg-apex-yellow text-apex-ink border border-apex-yellow transition-all flex-shrink-0"
              aria-label="Wyłącz filtr lokalizacji"
            >
              📍 Twoja lokalizacja ✕
            </button>
          )}

          <div className="flex border border-apex-border overflow-hidden flex-shrink-0 ml-auto" role="group" aria-label="Widok">
            <button onClick={() => onViewChange('list')}
              className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border-r border-apex-border transition-all ${view === 'list' ? 'bg-apex-yellow text-apex-ink' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
              Lista
            </button>
            <button onClick={() => onViewChange('calendar')}
              className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border-r border-apex-border transition-all ${view === 'calendar' ? 'bg-apex-yellow text-apex-ink' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
              Kalendarz
            </button>
            <button onClick={() => onViewChange('map')}
              className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 transition-all ${view === 'map' ? 'bg-apex-yellow text-apex-ink' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
              Mapa
            </button>
          </div>
        </div>

        {/* Row 2: Filter dropdowns */}
        <div className={`${open ? 'flex' : 'hidden'} md:flex flex-col md:flex-row md:flex-wrap gap-3 items-stretch md:items-center`}>
          <MultiSelect
            options={EVENT_TYPES}
            selected={filters.type}
            onChange={(val) => update('type', val)}
            allLabel="Typ: Wszystkie"
            ariaLabel="Filtruj po typie"
          />

          <MultiSelect
            options={VOIVODESHIPS.map(v => ({ value: v, label: v }))}
            selected={filters.voivodeship}
            onChange={(val) => update('voivodeship', val)}
            allLabel="Region: Cała Polska"
            ariaLabel="Filtruj po regionie"
          />

          <MultiSelect
            options={DISTANCES}
            selected={filters.distance}
            onChange={(val) => update('distance', val)}
            allLabel="Dystans: Wszystkie"
            ariaLabel="Filtruj po dystansie"
          />

          <TimeRangeSelect
            value={filters.timeRange}
            onChange={(val) => update('timeRange', val)}
          />

          {count > 0 && (
            <button
              type="button"
              onClick={() => onChange({ search: '', type: [], voivodeship: [], distance: [], timeRange: '' })}
              className="font-mono text-[11px] tracking-wide text-apex-yellow hover:text-apex-yellow-bright transition-colors flex-shrink-0 px-2 py-2.5"
            >
              Wyczyść filtry ✕
            </button>
          )}
        </div>

        {/* Row 3: Radius slider (only when location active) */}
        {userLocation && (
          <div className="flex items-center gap-4 w-full">
            <label htmlFor="radius-slider" className="font-mono text-xs text-apex-muted whitespace-nowrap flex-shrink-0">
              Promień:
            </label>
            <input
              id="radius-slider"
              type="range"
              min={5}
              max={200}
              value={radius}
              onChange={(e) => onRadiusChange(snapRadius(Number(e.target.value)))}
              className="flex-1 h-2 appearance-none bg-apex-border rounded-none cursor-pointer accent-apex-yellow [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-8 [&::-webkit-slider-thumb]:h-8 [&::-webkit-slider-thumb]:bg-apex-yellow [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-8 [&::-moz-range-thumb]:h-8 [&::-moz-range-thumb]:bg-apex-yellow [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:cursor-pointer"
              aria-label="Promień wyszukiwania w kilometrach"
            />
            <span className="font-mono text-sm font-semibold text-apex-yellow whitespace-nowrap flex-shrink-0 min-w-[56px] text-right">
              {radius} km
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export { EVENT_TYPES, VOIVODESHIPS, DISTANCES, TIME_RANGES }
