# Community Event Submission & Issue Reporting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone submit events and report issues on the public kalendarz, with admin moderation in the local frontend.

**Architecture:** Public app writes directly to Supabase (anon key) for submissions and reports. Admin frontend reads via backend API (service_role). New Supabase table `calendar_event_reports` for issue tracking. Events submitted with `status = 'pending'` are invisible in kalendarz until approved.

**Tech Stack:** React, Supabase JS client, Fastify, Tailwind v4 (apex-* tokens)

**Spec:** `docs/superpowers/specs/2026-03-24-community-event-submission-and-reporting-design.md`

---

### Task 1: Supabase schema — create reports table + RLS policies

**Files:**
- None (Supabase-only migrations via MCP tool)

- [ ] **Step 1: Create calendar_event_reports table**

Apply via `mcp__supabase__apply_migration`:
```sql
CREATE TABLE calendar_event_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT,
  suggested_value TEXT,
  source_url TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX idx_reports_event_id ON calendar_event_reports(calendar_event_id);
CREATE INDEX idx_reports_status ON calendar_event_reports(status);
```

- [ ] **Step 2: Add RLS policies**

Apply via `mcp__supabase__apply_migration`:
```sql
ALTER TABLE calendar_event_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can create reports" ON calendar_event_reports
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Anyone can submit pending events" ON calendar_events
  FOR INSERT TO anon WITH CHECK (status = 'pending');
```

- [ ] **Step 3: Verify**

Run via `mcp__supabase__execute_sql`:
```sql
SELECT tablename FROM pg_tables WHERE tablename = 'calendar_event_reports';
SELECT policyname FROM pg_policies WHERE tablename IN ('calendar_event_reports', 'calendar_events');
```

---

### Task 2: Public event submission form — DodajWydarzenie.jsx

**Files:**
- Create: `public/src/pages/DodajWydarzenie.jsx`
- Modify: `public/src/App.jsx:1-27`
- Modify: `public/src/pages/Kalendarz.jsx:166-170`

- [ ] **Step 1: Create DodajWydarzenie.jsx**

```jsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import Navbar from '../components/Navbar.jsx'
import Footer from '../components/Footer.jsx'
import useTheme from '../hooks/useTheme.js'

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
  const [form, setForm] = useState({
    name: '', date: '', location: '', voivodeship: '',
    registrationUrl: '', organizer: '', description: '', honeypot: '',
  })
  const [distances, setDistances] = useState([])
  const [customDist, setCustomDist] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const [eventTypes, setEventTypes] = useState([])
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

  const canSubmit = form.name.trim() && form.date && !submitting

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    // Honeypot check
    if (form.honeypot) { setSubmitted(true); return }

    setSubmitting(true)
    setError(null)

    const distStrings = distances.length ? distances : null
    const distMeters = distances.length
      ? distances.map(d => Math.round(parseFloat(d) * 1000))
      : null

    const { error: err } = await supabase.from('calendar_events').insert({
      name: form.name.trim(),
      date: form.date,
      location: form.location.trim() || null,
      voivodeship: form.voivodeship || null,
      distances: distStrings,
      distances_meters: distMeters,
      event_type: eventTypes.length ? eventTypes : null,
      registration_url: form.registrationUrl.trim() || null,
      organizer: form.organizer.trim() || null,
      description: form.description.trim() || null,
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
            {/* Honeypot */}
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
              <input type="text" value={form.location} onChange={set('location')} className={inputClass} placeholder="np. Zakopane" />
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
              <label className={labelClass}>Link do rejestracji</label>
              <input type="url" value={form.registrationUrl} onChange={set('registrationUrl')} className={inputClass} placeholder="https://..." />
            </div>

            <div>
              <label className={labelClass}>Organizator</label>
              <input type="text" value={form.organizer} onChange={set('organizer')} className={inputClass} placeholder="np. Fundacja Biegowa" />
            </div>

            <div>
              <label className={labelClass}>Opis</label>
              <textarea value={form.description} onChange={set('description')} rows={3} className={`${inputClass} resize-none`} placeholder="Krótki opis wydarzenia..." />
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
```

- [ ] **Step 2: Add route to App.jsx**

In `public/src/App.jsx`, add import and route. After line 3 (`import Kalendarz`), add:
```js
import DodajWydarzenie from './pages/DodajWydarzenie.jsx'
```

After line 15 (`<Route path="/kalendarz"...>`), add:
```jsx
<Route path="/kalendarz/dodaj" element={<DodajWydarzenie />} />
```

- [ ] **Step 3: Add "Dodaj wydarzenie" link to Kalendarz**

In `public/src/pages/Kalendarz.jsx`, replace the header area (lines 166-170) to include a CTA link. Add `import { Link } from 'react-router-dom'` to the existing import from `react-router-dom` (line 2). Then replace:

```jsx
          <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-2">Kalendarz biegów</p>
          <h1 className="font-display font-extrabold text-3xl md:text-5xl tracking-wider uppercase text-apex-text-bright mb-2">Wszystkie wydarzenia w Polsce</h1>
          <p className="text-base text-apex-text max-w-[600px]">Setki biegów, marszów nordic walking i wydarzeń sportowych z całej Polski.</p>
```

with:

```jsx
          <div className="flex justify-between items-start">
            <div>
              <p className="font-mono text-[11px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-2">Kalendarz biegów</p>
              <h1 className="font-display font-extrabold text-3xl md:text-5xl tracking-wider uppercase text-apex-text-bright mb-2">Wszystkie wydarzenia w Polsce</h1>
              <p className="text-base text-apex-text max-w-[600px]">Setki biegów, marszów nordic walking i wydarzeń sportowych z całej Polski.</p>
            </div>
            <Link to="/kalendarz/dodaj" className="hidden md:inline-block font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all flex-shrink-0 mt-1">
              + Dodaj wydarzenie
            </Link>
          </div>
```

- [ ] **Step 4: Commit**

```bash
git add public/src/pages/DodajWydarzenie.jsx public/src/App.jsx public/src/pages/Kalendarz.jsx
git commit -m "feat: add public event submission form at /kalendarz/dodaj

Anonymous users can submit events with name, date, location, distances,
event type, URL, organizer, and description. Events go to pending status
for admin moderation. Includes honeypot spam protection."
```

---

### Task 3: Issue reporting modal — ReportEventModal.jsx

**Files:**
- Create: `public/src/components/ReportEventModal.jsx`
- Modify: `public/src/components/EventRow.jsx:37-82`

- [ ] **Step 1: Create ReportEventModal.jsx**

```jsx
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

const VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

const EVENT_TYPES = ['trail', 'nocny', 'ocr', 'nordic', 'ultra', 'charytatywny', 'uliczny']

const FIELDS = [
  { value: 'name', label: 'Nazwa' },
  { value: 'date', label: 'Data' },
  { value: 'location', label: 'Miejsce' },
  { value: 'voivodeship', label: 'Województwo' },
  { value: 'distances', label: 'Dystanse' },
  { value: 'event_type', label: 'Typ wydarzenia' },
  { value: 'organizer', label: 'Organizator' },
  { value: 'registration_url', label: 'Link do rejestracji' },
  { value: 'cancelled', label: 'Wydarzenie odwołane' },
]

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2 px-3 outline-none focus:border-apex-yellow-dim transition-colors'
const labelClass = 'block font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted mb-1'

function getCurrentValue(event, field) {
  if (field === 'cancelled') return event.status === 'cancelled' ? 'Tak' : 'Nie'
  if (field === 'distances') return event.distances?.join(', ') || '—'
  if (field === 'event_type') return event.event_type?.join(', ') || '—'
  return event[field] || '—'
}

function SuggestedInput({ field, value, onChange }) {
  if (field === 'cancelled') return null

  if (field === 'date') {
    return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} />
  }

  if (field === 'voivodeship') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} appearance-none cursor-pointer`}>
        <option value="">— wybierz —</option>
        {VOIVODESHIPS.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }

  if (field === 'event_type') {
    const selected = value ? value.split(',').map(s => s.trim()).filter(Boolean) : []
    return (
      <div className="flex flex-wrap gap-1.5">
        {EVENT_TYPES.map(t => (
          <button key={t} type="button"
            onClick={() => {
              const next = selected.includes(t) ? selected.filter(x => x !== t) : [...selected, t]
              onChange(next.join(', '))
            }}
            className={`font-mono text-[10px] font-semibold px-2 py-1 border transition-all ${selected.includes(t) ? 'border-apex-cyan text-apex-cyan bg-apex-cyan/10' : 'border-apex-border text-apex-muted'}`}>
            {t}
          </button>
        ))}
      </div>
    )
  }

  if (field === 'registration_url') {
    return <input type="url" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} placeholder="https://..." />
  }

  return <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} />
}

export default function ReportEventModal({ event, onClose }) {
  const [field, setField] = useState('')
  const [suggestedValue, setSuggestedValue] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const [honeypot, setHoneypot] = useState('')

  const canSubmit = field && !submitting && (field === 'cancelled' || suggestedValue.trim())

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    if (honeypot) { setSubmitted(true); return }

    setSubmitting(true)
    setError(null)

    const { error: err } = await supabase.from('calendar_event_reports').insert({
      calendar_event_id: event.id,
      field,
      old_value: String(getCurrentValue(event, field)),
      suggested_value: field === 'cancelled' ? 'cancelled' : suggestedValue.trim(),
      source_url: sourceUrl.trim() || null,
      note: note.trim() || null,
    })

    setSubmitting(false)
    if (err) {
      setError('Nie udało się wysłać zgłoszenia.')
      console.error('Report error:', err.message)
    } else {
      setSubmitted(true)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-apex-bg border border-apex-border w-full max-w-[440px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-display font-bold text-base tracking-widest uppercase text-apex-text-bright">Zgłoś problem</h2>
            <button onClick={onClose} className="text-apex-muted hover:text-apex-text-bright text-lg leading-none">&times;</button>
          </div>

          <div className="text-sm text-apex-muted mb-4 truncate">{event.name}</div>

          {submitted ? (
            <div className="py-6 text-center">
              <div className="text-apex-yellow text-2xl mb-2">&#10003;</div>
              <p className="text-apex-text-bright font-display font-bold tracking-wide uppercase text-sm">Zgłoszenie wysłane</p>
              <p className="text-apex-muted text-xs mt-1">Dziękujemy za pomoc!</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="absolute -left-[9999px]" aria-hidden="true">
                <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
              </div>

              <div>
                <label className={labelClass}>Co jest nieprawidłowe?</label>
                <select value={field} onChange={(e) => { setField(e.target.value); setSuggestedValue('') }}
                  className={`${inputClass} appearance-none cursor-pointer`}>
                  <option value="">— wybierz pole —</option>
                  {FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>

              {field && (
                <>
                  <div>
                    <label className={labelClass}>Obecna wartość</label>
                    <div className="text-sm text-apex-muted bg-apex-surface border border-apex-border px-3 py-2 truncate">
                      {getCurrentValue(event, field)}
                    </div>
                  </div>

                  {field !== 'cancelled' && (
                    <div>
                      <label className={labelClass}>Prawidłowa wartość</label>
                      <SuggestedInput field={field} value={suggestedValue} onChange={setSuggestedValue} />
                    </div>
                  )}

                  <div>
                    <label className={labelClass}>Link do źródła</label>
                    <input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} className={inputClass} placeholder="https://oficjalna-strona.pl" />
                  </div>

                  <div>
                    <label className={labelClass}>Notatka (opcjonalnie)</label>
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`${inputClass} resize-none`} />
                  </div>

                  {error && <div className="text-apex-red text-xs">{error}</div>}

                  <button type="submit" disabled={!canSubmit}
                    className={`w-full font-display font-bold text-xs tracking-widest uppercase py-2.5 transition-all ${canSubmit ? 'bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright' : 'bg-apex-surface-2 text-apex-muted cursor-not-allowed border border-apex-border'}`}>
                    {submitting ? 'Wysyłanie...' : 'Wyślij zgłoszenie'}
                  </button>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add report icon to EventRow**

Modify `public/src/components/EventRow.jsx`. Add `useState` import and the modal. Replace the full file:

```jsx
import { useState } from 'react'
import ReportEventModal from './ReportEventModal.jsx'

const baseTag = 'font-mono text-[10px] font-semibold tracking-wide px-2 py-0.5 border uppercase'
const typeTagClass = `${baseTag} border-apex-cyan/30 text-apex-cyan`
const distTagClass = `${baseTag} border-[rgba(187,221,0,0.3)] text-apex-yellow-dim`

const TYPE_LABELS = {
  trail: 'przełajowy',
  nocny: 'nocny',
  ocr: 'OCR',
  nordic: 'nordic walking',
  ultra: 'ultramaraton',
  charytatywny: 'charytatywny',
  uliczny: 'uliczny',
}

function TypeTag({ label }) {
  if (!label) return null
  return <span className={typeTagClass}>{TYPE_LABELS[label] || label}</span>
}

function DistTag({ label }) {
  if (!label) return null
  return <span className={distTagClass}>{label}</span>
}

function extractCity(location) {
  if (!location) return null
  const cleaned = location.split(/[;:|]/)[0].trim()
  if (/^\d{4}/.test(cleaned)) return null
  if (cleaned.length > 40) return null
  const city = cleaned.split(',')[0].trim()
  return city || null
}

export default function EventRow({ event }) {
  const [showReport, setShowReport] = useState(false)
  const dateStr = new Date(event.date).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })
  const isLeszyrun = !!event.leszyrun_event_id

  const handleClick = () => {
    if (isLeszyrun && event.slug) {
      window.location.href = `/events/${event.slug}`
    } else if (event.registration_url) {
      window.open(event.registration_url, '_blank', 'noopener')
    }
  }

  const handleReport = (e) => {
    e.stopPropagation()
    setShowReport(true)
  }

  const city = extractCity(event.location)
  const types = event.event_type || []
  const typeLabel = types.length > 0 ? types[0] : null
  const distanceLabel = (event.distances && event.distances.length > 0)
    ? event.distances.join(' / ')
    : null

  return (
    <>
      <div
        onClick={handleClick}
        className="grid grid-cols-[70px_1fr_auto] md:grid-cols-[90px_1fr_auto] items-center gap-2 md:gap-4 px-3 md:px-4 py-3 md:py-3.5 bg-apex-surface border border-apex-border mb-0.5 hover:bg-apex-surface-2 hover:border-apex-border-mid transition-all cursor-pointer group"
        role="link"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      >
        <div className="font-mono text-[13px] font-semibold text-apex-yellow">{dateStr}</div>

        <div className="min-w-0">
          <div className="font-display font-bold text-[15px] md:text-[17px] tracking-wide uppercase text-apex-text-bright truncate">{event.name}</div>
          {city && <div className="text-[13px] text-apex-muted mt-0.5">{city}</div>}
        </div>

        <div className="flex gap-1.5 items-center flex-shrink-0">
          <div className="hidden md:flex gap-1.5 items-center">
            <TypeTag label={typeLabel} />
            <DistTag label={distanceLabel} />
            {isLeszyrun && (
              <span className="font-mono text-[9px] font-semibold tracking-wide px-2 py-0.5 bg-apex-yellow/10 text-apex-yellow border border-apex-yellow/20">
                LESZY.RUN
              </span>
            )}
          </div>
          <button onClick={handleReport} title="Zgłoś problem"
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-apex-dim hover:text-apex-yellow transition-all p-1 ml-1"
            aria-label="Zgłoś problem z tym wydarzeniem">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
              <line x1="4" y1="22" x2="4" y2="15" />
            </svg>
          </button>
        </div>
      </div>
      {showReport && <ReportEventModal event={event} onClose={() => setShowReport(false)} />}
    </>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add public/src/components/ReportEventModal.jsx public/src/components/EventRow.jsx
git commit -m "feat: add issue reporting modal on calendar events

Each event row in Kalendarz shows a flag icon on hover. Clicking opens
a modal where users can report incorrect fields, provide corrected values,
and link to a source. Reports go to calendar_event_reports table."
```

---

### Task 4: Backend API — reports endpoints + pending events

**Files:**
- Create: `backend/src/routes/calendarEventReports.js`
- Modify: `backend/src/routes/calendarEvents.js:102-119`
- Modify: `backend/src/server.js:27,57`

- [ ] **Step 1: Create calendarEventReports.js**

```js
import { supabase } from '../lib/supabaseClient.js'

export async function calendarEventReportsRoutes(fastify) {
  // List pending reports with event data
  fastify.get('/calendar-event-reports', async (request, reply) => {
    const { status = 'pending' } = request.query

    const { data: reports, error } = await supabase
      .from('calendar_event_reports')
      .select('*, calendar_events(*)')
      .eq('status', status)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })
    return { data: reports }
  })

  // Accept a report — update the event field + mark accepted
  fastify.patch('/calendar-event-reports/:id/accept', async (request, reply) => {
    const { id } = request.params
    const { suggested_value: override } = request.body || {}

    // Get the report
    const { data: report, error: fetchErr } = await supabase
      .from('calendar_event_reports')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchErr || !report) return reply.status(404).send({ error: 'Report not found' })

    const value = override !== undefined ? override : report.suggested_value

    // Build event update
    const eventUpdate = { updated_at: new Date().toISOString() }

    if (report.field === 'cancelled') {
      eventUpdate.status = 'cancelled'
    } else if (report.field === 'distances') {
      const parts = value.split(',').map(s => s.trim()).filter(Boolean)
      eventUpdate.distances = parts
      eventUpdate.distances_meters = parts.map(d => Math.round(parseFloat(d) * 1000))
    } else if (report.field === 'event_type') {
      eventUpdate.event_type = value.split(',').map(s => s.trim()).filter(Boolean)
    } else {
      eventUpdate[report.field] = value
    }

    // Update event
    const { error: updateErr } = await supabase
      .from('calendar_events')
      .update(eventUpdate)
      .eq('id', report.calendar_event_id)

    if (updateErr) return reply.status(500).send({ error: updateErr.message })

    // Mark report accepted
    const { error: reportErr } = await supabase
      .from('calendar_event_reports')
      .update({ status: 'accepted', reviewed_at: new Date().toISOString() })
      .eq('id', id)

    if (reportErr) return reply.status(500).send({ error: reportErr.message })
    return { success: true }
  })

  // Reject a report
  fastify.patch('/calendar-event-reports/:id/reject', async (request, reply) => {
    const { id } = request.params

    const { error } = await supabase
      .from('calendar_event_reports')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .eq('id', id)

    if (error) return reply.status(500).send({ error: error.message })
    return { success: true }
  })
}
```

- [ ] **Step 2: Add status filter + approve endpoint to calendarEvents.js**

In `backend/src/routes/calendarEvents.js`, modify the GET endpoint (line 102-119). Replace:

```js
  fastify.get('/calendar-events', async (request, reply) => {
    const { page = 1, limit = 200, source, filter } = request.query
    const from = (page - 1) * limit

    let query = supabase
      .from('calendar_events')
      .select('*', { count: 'exact' })
      .eq('status', 'active')
      .gte('date', new Date().toISOString().split('T')[0])
      .order('date', { ascending: true })
      .range(from, from + limit - 1)

    if (source) query = query.eq('source', source)

    const { data, count, error } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { data, total: count }
  })
```

with:

```js
  fastify.get('/calendar-events', async (request, reply) => {
    const { page = 1, limit = 200, source, filter, status = 'active' } = request.query
    const from = (page - 1) * limit

    let query = supabase
      .from('calendar_events')
      .select('*', { count: 'exact' })
      .eq('status', status)
      .order('date', { ascending: true })
      .range(from, from + limit - 1)

    // Only filter by date for active events (pending may have future dates too)
    if (status === 'active') {
      query = query.gte('date', new Date().toISOString().split('T')[0])
    }

    if (source) query = query.eq('source', source)

    const { data, count, error } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { data, total: count }
  })

  // Approve a pending event
  fastify.patch('/calendar-events/:id/approve', async (request, reply) => {
    const { id } = request.params
    const { data, error } = await supabase
      .from('calendar_events')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { data }
  })
```

- [ ] **Step 3: Register reports routes in server.js**

In `backend/src/server.js`, add import after line 27:
```js
import { calendarEventReportsRoutes } from './routes/calendarEventReports.js'
```

Add registration after line 57 (after `calendarEventsRoutes`):
```js
  await api.register(calendarEventReportsRoutes)
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/calendarEventReports.js backend/src/routes/calendarEvents.js backend/src/server.js
git commit -m "feat: add backend API for event reports and pending event approval

New /api/calendar-event-reports endpoints for listing, accepting, and
rejecting reports. Extend GET /api/calendar-events with status query
param. Add PATCH /api/calendar-events/:id/approve for pending events."
```

---

### Task 5: Admin moderation page — Moderation.jsx

**Files:**
- Create: `frontend/src/pages/Moderation.jsx`
- Modify: `frontend/src/App.jsx:1-34`

- [ ] **Step 1: Create Moderation.jsx**

```jsx
import { useState, useEffect, useCallback } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const tabClass = 'font-display font-bold text-sm tracking-widest uppercase px-4 py-2 transition-all'
const activeTab = 'text-apex-yellow border-b-2 border-apex-yellow'
const inactiveTab = 'text-apex-muted hover:text-apex-text-bright'
const btnBase = 'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 transition-all'

export default function Moderation() {
  const [tab, setTab] = useState('pending')
  const [pendingEvents, setPendingEvents] = useState([])
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingReport, setEditingReport] = useState(null)
  const [editValue, setEditValue] = useState('')

  const fetchPending = useCallback(async () => {
    const res = await fetch(`${API}/api/calendar-events?status=pending&limit=500`)
    const json = await res.json()
    setPendingEvents(json.data || [])
  }, [])

  const fetchReports = useCallback(async () => {
    const res = await fetch(`${API}/api/calendar-event-reports?status=pending`)
    const json = await res.json()
    setReports(json.data || [])
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchPending(), fetchReports()]).finally(() => setLoading(false))
  }, [fetchPending, fetchReports])

  const approveEvent = async (id) => {
    await fetch(`${API}/api/calendar-events/${id}/approve`, { method: 'PATCH' })
    setPendingEvents(prev => prev.filter(e => e.id !== id))
  }

  const deleteEvent = async (id) => {
    await fetch(`${API}/api/calendar-events/${id}`, { method: 'DELETE' })
    setPendingEvents(prev => prev.filter(e => e.id !== id))
  }

  const acceptReport = async (id, overrideValue) => {
    const body = overrideValue !== undefined ? { suggested_value: overrideValue } : undefined
    await fetch(`${API}/api/calendar-event-reports/${id}/accept`, {
      method: 'PATCH',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    setReports(prev => prev.filter(r => r.id !== id))
    setEditingReport(null)
  }

  const rejectReport = async (id) => {
    await fetch(`${API}/api/calendar-event-reports/${id}/reject`, { method: 'PATCH' })
    setReports(prev => prev.filter(r => r.id !== id))
  }

  // Group reports by event
  const reportsByEvent = reports.reduce((acc, r) => {
    const eventId = r.calendar_event_id
    if (!acc[eventId]) acc[eventId] = { event: r.calendar_events, reports: [] }
    acc[eventId].reports.push(r)
    return acc
  }, {})

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display font-extrabold text-2xl tracking-wider uppercase text-apex-text-bright">Moderacja</h1>
        <p className="text-sm text-apex-muted mt-1">Zgłoszenia społeczności i oczekujące wydarzenia</p>
      </div>

      <div className="flex gap-4 border-b border-apex-border">
        <button onClick={() => setTab('pending')} className={`${tabClass} ${tab === 'pending' ? activeTab : inactiveTab}`}>
          Oczekujące ({pendingEvents.length})
        </button>
        <button onClick={() => setTab('reports')} className={`${tabClass} ${tab === 'reports' ? activeTab : inactiveTab}`}>
          Zgłoszenia ({reports.length})
        </button>
      </div>

      {loading && <div className="text-apex-muted py-8">Ładowanie...</div>}

      {!loading && tab === 'pending' && (
        <div className="space-y-3">
          {pendingEvents.length === 0 && <div className="text-apex-muted py-8 text-center">Brak oczekujących wydarzeń.</div>}
          {pendingEvents.map(ev => (
            <div key={ev.id} className="bg-apex-surface border border-apex-border p-4">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <div className="font-display font-bold text-base tracking-wide uppercase text-apex-text-bright">{ev.name}</div>
                  <div className="text-sm text-apex-muted mt-0.5">{ev.date} &middot; {ev.location || '—'} &middot; {ev.voivodeship || '—'}</div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => approveEvent(ev.id)} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>Zatwierdź</button>
                  <button onClick={() => deleteEvent(ev.id)} className={`${btnBase} border border-apex-red text-apex-red hover:bg-apex-red hover:text-white`}>Usuń</button>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                {ev.distances && <div><span className="text-apex-dim">Dystanse:</span> <span className="text-apex-text">{ev.distances.join(', ')}</span></div>}
                {ev.event_type && <div><span className="text-apex-dim">Typ:</span> <span className="text-apex-text">{ev.event_type.join(', ')}</span></div>}
                {ev.organizer && <div><span className="text-apex-dim">Organizator:</span> <span className="text-apex-text">{ev.organizer}</span></div>}
                {ev.registration_url && <div><span className="text-apex-dim">URL:</span> <a href={ev.registration_url} target="_blank" rel="noopener" className="text-apex-cyan hover:underline truncate">{ev.registration_url}</a></div>}
              </div>
              {ev.description && <div className="text-xs text-apex-muted mt-2 line-clamp-2">{ev.description}</div>}
            </div>
          ))}
        </div>
      )}

      {!loading && tab === 'reports' && (
        <div className="space-y-4">
          {Object.keys(reportsByEvent).length === 0 && <div className="text-apex-muted py-8 text-center">Brak zgłoszeń do przejrzenia.</div>}
          {Object.entries(reportsByEvent).map(([eventId, { event, reports: evReports }]) => (
            <div key={eventId} className="bg-apex-surface border border-apex-border p-4">
              <div className="font-display font-bold text-sm tracking-wide uppercase text-apex-text-bright mb-3">
                {event?.name || 'Nieznane wydarzenie'} <span className="text-apex-muted font-mono text-[10px] font-normal ml-2">{event?.date}</span>
              </div>
              <div className="space-y-2">
                {evReports.map(r => (
                  <div key={r.id} className="border border-apex-border bg-apex-bg p-3">
                    <div className="font-mono text-[10px] font-semibold tracking-widest uppercase text-apex-yellow-dim mb-2">{r.field}</div>
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start mb-2">
                      <div>
                        <div className="text-[10px] text-apex-dim uppercase mb-0.5">Obecna</div>
                        <div className="text-sm text-apex-muted">{r.old_value || '—'}</div>
                      </div>
                      <div className="text-apex-dim self-center">&rarr;</div>
                      <div>
                        <div className="text-[10px] text-apex-dim uppercase mb-0.5">Sugerowana</div>
                        {editingReport === r.id ? (
                          <input type="text" value={editValue} onChange={(e) => setEditValue(e.target.value)}
                            className="w-full bg-apex-surface border border-apex-yellow-dim text-apex-text-bright text-sm py-1 px-2 outline-none"
                            autoFocus onKeyDown={(e) => e.key === 'Enter' && acceptReport(r.id, editValue)} />
                        ) : (
                          <div className="text-sm text-apex-text-bright">{r.suggested_value || '—'}</div>
                        )}
                      </div>
                    </div>
                    {r.source_url && (
                      <div className="text-[10px] mb-2">
                        <span className="text-apex-dim">Źródło: </span>
                        <a href={r.source_url} target="_blank" rel="noopener" className="text-apex-cyan hover:underline">{r.source_url}</a>
                      </div>
                    )}
                    {r.note && <div className="text-[10px] text-apex-muted mb-2">Notatka: {r.note}</div>}
                    <div className="flex gap-2">
                      {editingReport === r.id ? (
                        <>
                          <button onClick={() => acceptReport(r.id, editValue)} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>Zapisz</button>
                          <button onClick={() => setEditingReport(null)} className={`${btnBase} border border-apex-border text-apex-muted`}>Anuluj</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => acceptReport(r.id)} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>Akceptuj</button>
                          <button onClick={() => { setEditingReport(r.id); setEditValue(r.suggested_value || '') }} className={`${btnBase} border border-apex-border text-apex-muted hover:text-apex-text-bright`}>Edytuj</button>
                          <button onClick={() => rejectReport(r.id)} className={`${btnBase} border border-apex-red/50 text-apex-red hover:bg-apex-red hover:text-white`}>Odrzuć</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add route to admin App.jsx**

In `frontend/src/App.jsx`, add import after line 11:
```js
import Moderation from './pages/Moderation.jsx'
```

Add route inside the `<Route element={<Layout />}>` block, after line 26 (`calendar-events/new`):
```jsx
          <Route path="/moderation" element={<Moderation />} />
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Moderation.jsx frontend/src/App.jsx
git commit -m "feat: add admin moderation page for pending events and reports

Two-tab view: Pending Events (approve/delete) and Reports (accept with
before/after comparison, inline edit, reject). Reads via backend API."
```

---

### Task 6: Add moderation link to admin nav

**Files:**
- Modify: admin Layout/nav component (find the navigation links)

- [ ] **Step 1: Find and modify admin nav**

Look for the sidebar/nav in `frontend/src/components/layout/Layout.jsx` or similar. Add a "Moderacja" link pointing to `/moderation`, placed after the "Kalendarz" link.

Use the same link pattern as existing nav items. The link text should be "Moderacja".

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/layout/Layout.jsx
git commit -m "feat: add Moderacja link to admin nav"
```
