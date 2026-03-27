import { useState } from 'react'

const EVENT_TYPES = [
  { value: '', label: 'Typ: Wszystkie' },
  { value: 'uliczny', label: 'Bieg uliczny' },
  { value: 'trail', label: 'Przełajowy / Trail' },
  { value: 'ultra', label: 'Ultramaraton' },
  { value: 'nordic', label: 'Nordic Walking' },
  { value: 'ocr', label: 'OCR' },
  { value: 'nocny', label: 'Bieg nocny' },
  { value: 'charytatywny', label: 'Charytatywny' },
]

const VOIVODESHIPS = [
  '', 'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie', 'Wielkopolskie', 'Zachodniopomorskie',
]

const DISTANCES = [
  { value: '', label: 'Dystans: Wszystkie' },
  { value: '0-5000', label: 'do 5 km' },
  { value: '5000-10000', label: '5-10 km' },
  { value: '10000-21100', label: '10-21 km' },
  { value: '21100-21100', label: 'Półmaraton' },
  { value: '42200-42200', label: 'Maraton' },
  { value: '50000-999999', label: 'Ultra (50+ km)' },
]

const TIME_RANGES = [
  { value: '', label: 'Kiedy: Najbliższe' },
  { value: 'week', label: 'Ten tydzień' },
  { value: 'month', label: 'Ten miesiąc' },
  { value: 'next-month', label: 'Następny miesiąc' },
  { value: 'year', label: 'Cały rok' },
]

const selectClass = "bg-apex-surface border border-apex-border text-apex-text font-sans text-sm font-semibold py-2.5 pl-3.5 pr-8 outline-none appearance-none cursor-pointer focus:border-apex-yellow-dim w-full md:w-auto"

const SNAP_POINTS = [10, 25, 50, 100, 150, 200]
const SNAP_THRESHOLD = 0.08 * (200 - 5) // ~8% of range = ~15.6

function snapRadius(value) {
  for (const snap of SNAP_POINTS) {
    if (Math.abs(value - snap) <= SNAP_THRESHOLD) return snap
  }
  return value
}

function activeFilterCount(filters, userLocation) {
  let count = 0
  if (filters.type) count++
  if (filters.voivodeship) count++
  if (filters.distance) count++
  if (filters.timeRange) count++
  if (userLocation) count++
  return count
}

export default function FilterBar({ filters, onChange, view, onViewChange, userLocation, radius, onLocationRequest, onLocationClear, onRadiusChange }) {
  const [open, setOpen] = useState(false)
  const update = (key, value) => onChange({ ...filters, [key]: value })
  const count = activeFilterCount(filters, userLocation)

  return (
    <div className="sticky top-14 z-40 bg-apex-bg/92 backdrop-blur-md border-b border-apex-border py-4">
      <div className="max-w-[1200px] mx-auto px-6 flex flex-col gap-3">
        {/* Row 1: Search + Blisko mnie (left) ... Lista/Mapa (right) */}
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

          <div className="flex border border-apex-border overflow-hidden flex-shrink-0 ml-auto" role="group" aria-label="Widok">
            <button onClick={() => onViewChange('list')}
              className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border-r border-apex-border transition-all ${view === 'list' ? 'bg-apex-yellow text-apex-ink' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
              Lista
            </button>
            <button onClick={() => onViewChange('map')}
              className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 transition-all ${view === 'map' ? 'bg-apex-yellow text-apex-ink' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
              Mapa
            </button>
          </div>
        </div>

        {/* Row 2: Filter dropdowns (+ mobile-only: Blisko mnie, Lista/Mapa) */}
        <div className={`${open ? 'flex' : 'hidden'} md:flex flex-col md:flex-row md:flex-wrap gap-3 items-stretch md:items-center`}>
          <select value={filters.type} onChange={(e) => update('type', e.target.value)} className={selectClass} aria-label="Filtruj po typie">
            {EVENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>

          <select value={filters.voivodeship} onChange={(e) => update('voivodeship', e.target.value)} className={selectClass} aria-label="Filtruj po regionie">
            <option value="">Region: Cała Polska</option>
            {VOIVODESHIPS.filter(Boolean).map(v => <option key={v} value={v}>{v}</option>)}
          </select>

          <select value={filters.distance} onChange={(e) => update('distance', e.target.value)} className={selectClass} aria-label="Filtruj po dystansie">
            {DISTANCES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>

          <select value={filters.timeRange} onChange={(e) => update('timeRange', e.target.value)} className={selectClass} aria-label="Filtruj po czasie">
            {TIME_RANGES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>

          {!userLocation ? (
            <button
              onClick={onLocationRequest}
              className="md:hidden font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all flex-shrink-0"
              aria-label="Pokaż wydarzenia blisko mnie"
            >
              📍 Blisko mnie
            </button>
          ) : (
            <button
              onClick={onLocationClear}
              className="md:hidden font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 bg-apex-yellow text-apex-ink border border-apex-yellow transition-all flex-shrink-0"
              aria-label="Wyłącz filtr lokalizacji"
            >
              📍 Twoja lokalizacja ✕
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
