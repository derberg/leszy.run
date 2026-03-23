const EVENT_TYPES = [
  { value: '', label: 'Typ: Wszystkie' },
  { value: 'uliczny', label: 'Bieg uliczny' },
  { value: 'trail', label: 'Trail' },
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
  { value: '3months', label: 'Za 3 miesiące' },
  { value: 'year', label: 'Caly rok' },
]

const selectClass = "bg-apex-surface border border-apex-border text-apex-text font-sans text-sm font-semibold py-2.5 pl-3.5 pr-8 outline-none appearance-none cursor-pointer focus:border-apex-yellow-dim w-full md:w-auto"

export default function FilterBar({ filters, onChange, view, onViewChange }) {
  const update = (key, value) => onChange({ ...filters, [key]: value })

  return (
    <div className="sticky top-14 z-40 bg-apex-bg/92 backdrop-blur-md border-b border-apex-border py-4 px-6">
      <div className="max-w-[1200px] mx-auto flex flex-col md:flex-row gap-3 items-stretch md:items-center">
        <input
          type="text"
          placeholder="Szukaj po nazwie, miejscu..."
          value={filters.search}
          onChange={(e) => update('search', e.target.value)}
          className="flex-1 min-w-[200px] bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-[15px] font-medium py-2.5 px-4 outline-none focus:border-apex-yellow-dim placeholder:text-apex-muted"
          aria-label="Szukaj wydarzeń"
        />

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

        <div className="flex border border-apex-border overflow-hidden flex-shrink-0" role="group" aria-label="Widok">
          <button onClick={() => onViewChange('list')}
            className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 border-r border-apex-border transition-all ${view === 'list' ? 'bg-apex-yellow text-apex-bg' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
            Lista
          </button>
          <button onClick={() => onViewChange('map')}
            className={`font-sans text-[13px] font-semibold tracking-wide uppercase px-4 py-2.5 transition-all ${view === 'map' ? 'bg-apex-yellow text-apex-bg' : 'bg-apex-surface text-apex-muted hover:bg-apex-surface-2 hover:text-apex-text-bright'}`}>
            Mapa
          </button>
        </div>
      </div>
    </div>
  )
}

export { EVENT_TYPES, VOIVODESHIPS, DISTANCES, TIME_RANGES }
