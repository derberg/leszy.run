import { useState, lazy, Suspense } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import useTheme from '../hooks/useTheme.js'
import useSeo from '../hooks/useSeo.js'

const DraggableMap = lazy(() => import('../components/DraggableMap.jsx'))

const VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

const EVENT_TYPES = [
  { value: 'uliczny', label: 'Uliczny' },
  { value: 'trail', label: 'Przełajowy / Trail' },
  { value: 'ultra', label: 'Ultramaraton' },
  { value: 'nordic', label: 'Nordic Walking' },
  { value: 'ocr', label: 'OCR / Bieg z przeszkodami' },
  { value: 'nocny', label: 'Nocny' },
  { value: 'charytatywny', label: 'Charytatywny' },
]

const PRESET_DISTANCES = ['5 km', '10 km', '21.1 km', '42.2 km', '50 km', '100 km']

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2.5 px-3.5 outline-none focus:border-apex-yellow-dim transition-colors'
const labelClass = 'block font-display font-bold text-xs tracking-widest uppercase text-apex-muted mb-1.5'

export default function DodajWydarzenie() {
  useSeo({
    title: 'Dodaj wydarzenie biegowe',
    description: 'Zgłoś bieg, marsz nordic walking lub inne wydarzenie sportowe do kalendarza Leszy.run. Twoje wydarzenie trafi do setek biegaczy w Polsce.',
    path: '/kalendarz/dodaj',
  })

  const [form, setForm] = useState({
    name: '', date: '', location: '', voivodeship: '',
    registrationUrl: '', honeypot: '',
  })
  const [distances, setDistances] = useState([])
  const [customDist, setCustomDist] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const [eventTypes, setEventTypes] = useState([])
  const [showExtras, setShowExtras] = useState(false)
  const [website, setWebsite] = useState('')
  const [regulaminUrl, setRegulaminUrl] = useState('')
  const [priceFrom, setPriceFrom] = useState('')
  const [priceTo, setPriceTo] = useState('')
  const [regDeadline, setRegDeadline] = useState('')
  const [mapLat, setMapLat] = useState(null)
  const [mapLng, setMapLng] = useState(null)
  const [mapMoved, setMapMoved] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const { isDark } = useTheme()

  const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

  const toggleDistance = (d) => {
    setDistances(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])
  }

  const addCustomDistance = () => {
    const km = parseFloat(customDist.replace(',', '.'))
    if (km > 0 && km < 500) {
      const label = `${km} km`
      if (!distances.includes(label)) setDistances(prev => [...prev, label])
      setCustomDist('')
      setShowCustom(false)
    }
  }

  const toggleType = (t) => {
    setEventTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }

  const geocodeCity = async (city) => {
    if (!city.trim()) return
    try {
      const params = new URLSearchParams({
        q: `${city.trim()}, Polska`, format: 'json', limit: '1', countrycodes: 'pl',
      })
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
      })
      const results = await res.json()
      if (results.length > 0 && !mapMoved) {
        setMapLat(parseFloat(results[0].lat))
        setMapLng(parseFloat(results[0].lon))
      }
    } catch {}
  }

  const canSubmit = form.name.trim() && form.date && !submitting

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    if (form.honeypot) { setSubmitted(true); return }

    setSubmitting(true)
    setError(null)

    const distStrings = distances.length ? distances : null

    // Geocode location via Nominatim
    let lat = null
    let lng = null
    const locationTrimmed = form.location.trim()
    if (locationTrimmed) {
      try {
        const params = new URLSearchParams({
          q: `${locationTrimmed}, Polska`,
          format: 'json',
          limit: '1',
          countrycodes: 'pl',
        })
        const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
          headers: { 'User-Agent': 'leszy.run/1.0 (kontakt@leszy.run)' },
        })
        const geoResults = await geoRes.json()
        if (geoResults.length > 0) {
          lat = parseFloat(geoResults[0].lat)
          lng = parseFloat(geoResults[0].lon)
        }
      } catch {}
    }

    const finalLat = mapMoved ? mapLat : lat
    const finalLng = mapMoved ? mapLng : lng

    const { error: err } = await supabase.from('calendar_events').insert({
      name: form.name.trim(),
      date: form.date,
      location: locationTrimmed || null,
      voivodeship: form.voivodeship || null,
      distances: distStrings,
      event_type: eventTypes.length ? eventTypes : null,
      registration_url: form.registrationUrl.trim() || null,
      website: website.trim() || null,
      regulamin_url: regulaminUrl.trim() || null,
      price_from: priceFrom ? parseInt(priceFrom, 10) : null,
      price_to: priceTo ? parseInt(priceTo, 10) : null,
      registration_deadline: regDeadline || null,
      lat: finalLat,
      lng: finalLng,
      source: 'community',
      status: 'pending',
    })

    setSubmitting(false)
    if (err) {
      setError('Nie udało się wysłać. Spróbuj ponownie.')
      console.error('Submit error:', err.message)
    } else {
      setSubmitted(true)
    }
  }

  if (submitted) {
    return (
      <>
        <Navbar />
        <main className="relative">
          <div className="fixed inset-0 flex items-center justify-center pointer-events-none z-0" aria-hidden="true">
            <img src="/logo-bez-napisu.svg" alt="" className={`w-[80vh] max-w-[90vw] h-auto ${isDark ? 'opacity-[0.04]' : 'opacity-[0.06]'}`}
              style={{ filter: isDark ? 'brightness(1.4) drop-shadow(0 0 20px rgba(45,90,39,0.6))' : 'drop-shadow(0 0 20px rgba(45,90,39,0.1))' }} />
          </div>
          <div className="pt-24 pb-16 px-6 max-w-[600px] mx-auto relative z-10 text-center">
            <div className="text-apex-yellow text-4xl mb-4">&#10003;</div>
            <h1 className="font-display font-extrabold text-2xl md:text-3xl tracking-wider uppercase text-apex-text-bright mb-4">Wydarzenie zgłoszone</h1>
            <p className="text-apex-text mb-8">Twoje zgłoszenie oczekuje na moderację. Pojawi się w kalendarzu po zatwierdzeniu.</p>
            <Link to="/kalendarz" className="inline-block font-display font-bold text-sm tracking-widest uppercase px-6 py-3 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all">
              Wróć do kalendarza
            </Link>
          </div>
        </main>
        <Footer />
      </>
    )
  }

  return (
    <>
      <Navbar />
      <main className="relative">
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none z-0" aria-hidden="true">
          <img src="/logo-bez-napisu.svg" alt="" className={`w-[80vh] max-w-[90vw] h-auto ${isDark ? 'opacity-[0.04]' : 'opacity-[0.06]'}`}
            style={{ filter: isDark ? 'brightness(1.4) drop-shadow(0 0 20px rgba(45,90,39,0.6))' : 'drop-shadow(0 0 20px rgba(45,90,39,0.1))' }} />
        </div>
        <div className="pt-20 pb-16 px-6 max-w-[600px] mx-auto relative z-10">
          <Link to="/kalendarz" className="inline-block font-mono text-[11px] text-apex-muted hover:text-apex-yellow-dim transition-colors mb-4">&larr; Kalendarz</Link>
          <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-2">Dodaj wydarzenie</p>
          <h1 className="font-display font-extrabold text-2xl md:text-3xl tracking-wider uppercase text-apex-text-bright mb-1">Zgłoś nowy bieg</h1>
          <p className="text-sm text-apex-muted mb-8">Wypełnij formularz. Wydarzenie pojawi się po zatwierdzeniu przez moderatora.</p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="absolute -left-[9999px]" aria-hidden="true">
              <input type="text" name="website" tabIndex={-1} autoComplete="off" value={form.honeypot} onChange={set('honeypot')} />
            </div>

            <div>
              <label className={labelClass}>Nazwa wydarzenia *</label>
              <input type="text" value={form.name} onChange={set('name')} className={inputClass} placeholder="np. Bieg Leszego 2026" required />
            </div>

            <div>
              <label className={labelClass}>Data *</label>
              <input type="date" value={form.date} onChange={set('date')} className={inputClass} required />
            </div>

            <div>
              <label className={labelClass}>Miasto</label>
              <input type="text" value={form.location} onChange={set('location')} onBlur={() => geocodeCity(form.location)} className={inputClass} placeholder="np. Zakopane" />
            </div>

            <div>
              <label className={labelClass}>Województwo</label>
              <select value={form.voivodeship} onChange={set('voivodeship')} className={`${inputClass} appearance-none cursor-pointer`}>
                <option value="">— wybierz —</option>
                {VOIVODESHIPS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>

            <div>
              <label className={labelClass}>Dystanse</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {PRESET_DISTANCES.map(d => (
                  <button key={d} type="button" onClick={() => toggleDistance(d)}
                    className={`font-mono text-[11px] font-semibold px-3 py-1.5 border transition-all ${distances.includes(d) ? 'border-apex-yellow text-apex-yellow bg-apex-yellow/10' : 'border-apex-border text-apex-muted hover:border-apex-border-mid'}`}>
                    {d}
                  </button>
                ))}
                <button type="button" onClick={() => setShowCustom(!showCustom)}
                  className={`font-mono text-[11px] font-semibold px-3 py-1.5 border transition-all ${showCustom ? 'border-apex-cyan text-apex-cyan' : 'border-apex-border text-apex-muted hover:border-apex-border-mid'}`}>
                  Inny
                </button>
              </div>
              {showCustom && (
                <div className="flex gap-2">
                  <input type="text" value={customDist} onChange={(e) => setCustomDist(e.target.value)}
                    className={`${inputClass} flex-1`} placeholder="np. 15" onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCustomDistance())} />
                  <button type="button" onClick={addCustomDistance}
                    className="font-mono text-[11px] font-semibold px-4 py-2 border border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all">km</button>
                </div>
              )}
              {distances.filter(d => !PRESET_DISTANCES.includes(d)).length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {distances.filter(d => !PRESET_DISTANCES.includes(d)).map(d => (
                    <button key={d} type="button" onClick={() => toggleDistance(d)}
                      className="font-mono text-[11px] font-semibold px-3 py-1.5 border border-apex-yellow text-apex-yellow bg-apex-yellow/10">
                      {d} &times;
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className={labelClass}>Typ wydarzenia</label>
              <div className="flex flex-wrap gap-2">
                {EVENT_TYPES.map(t => (
                  <button key={t.value} type="button" onClick={() => toggleType(t.value)}
                    className={`font-mono text-[11px] font-semibold px-3 py-1.5 border transition-all ${eventTypes.includes(t.value) ? 'border-apex-cyan text-apex-cyan bg-apex-cyan/10' : 'border-apex-border text-apex-muted hover:border-apex-border-mid'}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className={labelClass}>Link do wydarzenia</label>
              <input type="url" value={form.registrationUrl} onChange={set('registrationUrl')} className={inputClass} placeholder="https://..." />
            </div>

            {/* Expandable extras */}
            <div className="border border-apex-border">
              <button type="button" onClick={() => setShowExtras(!showExtras)}
                className="w-full flex justify-between items-center px-4 py-3">
                <span className="font-display font-bold text-[10px] tracking-widest uppercase text-apex-yellow">
                  {showExtras ? '▲' : '▼'} Więcej szczegółów
                </span>
                <span className="text-[10px] text-apex-muted">opcjonalne</span>
              </button>
              {showExtras && (
                <div className="px-4 pb-4 space-y-4">
                  <div>
                    <label className={labelClass}>Strona wydarzenia</label>
                    <input type="url" value={website} onChange={(e) => setWebsite(e.target.value)}
                      className={inputClass} placeholder="https://..." />
                  </div>
                  <div>
                    <label className={labelClass}>Link do regulaminu</label>
                    <input type="url" value={regulaminUrl} onChange={(e) => setRegulaminUrl(e.target.value)}
                      className={inputClass} placeholder="https://..." />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>Cena od (zł)</label>
                      <input type="number" min="0" value={priceFrom} onChange={(e) => setPriceFrom(e.target.value)}
                        className={inputClass} placeholder="np. 50" />
                    </div>
                    <div>
                      <label className={labelClass}>Cena do (zł)</label>
                      <input type="number" min="0" value={priceTo} onChange={(e) => setPriceTo(e.target.value)}
                        className={inputClass} placeholder="np. 120" />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>Termin zapisów</label>
                    <input type="date" value={regDeadline} onChange={(e) => setRegDeadline(e.target.value)}
                      className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Dokładna lokalizacja</label>
                    <Suspense fallback={<div className="border border-apex-border bg-apex-surface" style={{ height: 180 }} />}>
                      <DraggableMap
                        lat={mapLat}
                        lng={mapLng}
                        onChange={(newLat, newLng) => {
                          setMapLat(newLat)
                          setMapLng(newLng)
                          setMapMoved(true)
                        }}
                      />
                    </Suspense>
                  </div>
                </div>
              )}
            </div>

            {error && <div className="text-apex-red text-sm">{error}</div>}

            <button type="submit" disabled={!canSubmit}
              className={`w-full font-display font-bold text-sm tracking-widest uppercase py-3.5 transition-all ${canSubmit ? 'bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright' : 'bg-apex-surface-2 text-apex-muted cursor-not-allowed border border-apex-border'}`}>
              {submitting ? 'Wysyłanie...' : 'Zgłoś wydarzenie'}
            </button>
          </form>
        </div>
      </main>
      <Footer />
    </>
  )
}
