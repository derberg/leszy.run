# Community Forms Enrichment + Schema Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand community forms (DodajWydarzenie + Zgłoś poprawkę) to support all event page fields, clean up unused DB columns, and wire up regulamin_url/price/deadline through the publish pipeline.

**Architecture:** Two Supabase migrations (calendar_events cleanup + scraper_all rename/add), then backend code updates (publish script, normalizer, dedup, API routes), then frontend form enhancements (expandable section with map picker in DodajWydarzenie, new fields in ReportEventModal).

**Tech Stack:** Supabase (migrations), Leaflet + react-leaflet (draggable map pin), React (forms)

**Spec:** `docs/superpowers/specs/2026-04-03-community-forms-enrichment-design.md`

---

### Task 1: Supabase migration — calendar_events cleanup + regulamin_url

**Files:**
- Supabase migration (applied via `mcp__supabase__apply_migration`)

- [ ] **Step 1: Apply migration to drop unused columns and add regulamin_url**

```sql
-- Drop unused columns (all have 0 rows of data)
ALTER TABLE calendar_events DROP COLUMN IF EXISTS max_participants;
ALTER TABLE calendar_events DROP COLUMN IF EXISTS surface;
ALTER TABLE calendar_events DROP COLUMN IF EXISTS elevation_gain_m;
ALTER TABLE calendar_events DROP COLUMN IF EXISTS end_date;
ALTER TABLE calendar_events DROP COLUMN IF EXISTS is_night;
ALTER TABLE calendar_events DROP COLUMN IF EXISTS is_charity;
ALTER TABLE calendar_events DROP COLUMN IF EXISTS is_recurring;
ALTER TABLE calendar_events DROP COLUMN IF EXISTS recurring_event_id;
ALTER TABLE calendar_events DROP COLUMN IF EXISTS edition_number;

-- Add regulamin_url
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS regulamin_url text;
```

- [ ] **Step 2: Verify migration**

Run: `mcp__supabase__execute_sql` with:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'calendar_events'
ORDER BY ordinal_position;
```

Expected: no `max_participants`, `surface`, `elevation_gain_m`, `end_date`, `is_night`, `is_charity`, `is_recurring`, `recurring_event_id`, `edition_number`. Should see `regulamin_url`.

---

### Task 2: Supabase migration — scraper_all rename end_date + add price columns

**Files:**
- Supabase migration (applied via `mcp__supabase__apply_migration`)

- [ ] **Step 1: Apply migration**

```sql
-- Rename end_date to registration_deadline
ALTER TABLE scraper_all RENAME COLUMN end_date TO registration_deadline;

-- Add price columns
ALTER TABLE scraper_all ADD COLUMN IF NOT EXISTS price_from integer;
ALTER TABLE scraper_all ADD COLUMN IF NOT EXISTS price_to integer;
```

- [ ] **Step 2: Verify migration**

Run: `mcp__supabase__execute_sql` with:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'scraper_all'
AND column_name IN ('end_date', 'registration_deadline', 'price_from', 'price_to')
ORDER BY column_name;
```

Expected: `price_from`, `price_to`, `registration_deadline` present. No `end_date`.

---

### Task 3: Update backend scraper code for end_date → registration_deadline

**Files:**
- Modify: `backend/src/scrapers/index.js` (lines 82, 212, 354, 552)
- Modify: `backend/src/scrapers/dedup.js` (lines 19-20, 25-28)
- Modify: `backend/src/scrapers/normalizer.js` (line 313, 325-326)
- Modify: `backend/src/scrapers/sources/dostartu.js` (line 156)
- Modify: `backend/scripts/run-dedup.js` (lines 28, 174)

- [ ] **Step 1: Update `backend/src/scrapers/index.js`**

In the `sources` array, `dostartu` mapRow (line 82): change `end_date` to `registration_deadline`:
```js
      registration_deadline: raw.end_date || null,
```

Note: The dostartu scraper still outputs `end_date` from the API. We map it to `registration_deadline` here. The other source mapRows that reference `end_date` (lines ~60-70 for other scrapers) — check each one. Any that have `end_date` should be renamed to `registration_deadline`.

In `RAW_MERGE_FIELDS` (line 212): replace `'end_date'` with `'registration_deadline'`:
```js
const RAW_MERGE_FIELDS = [
  'name', 'date', 'registration_deadline', 'location', 'voivodeship',
  'lat', 'lng', 'distances', 'event_type', 'event_types',
  'registration_url', 'regulamin_url', 'regulamin_urls', 'website',
  'is_kids',
]
```

In the `mergeIntoScraperAll` row builder (~line 354): change `end_date` to `registration_deadline`:
```js
            registration_deadline: raw.end_date || raw.registration_deadline || null,
```

In `publishToCalendar` row builder (~line 549-568): replace `end_date` with new fields:
```js
    const row = {
      name: raw.name,
      date: raw.date,
      location: raw.location || null,
      voivodeship: raw.voivodeship || null,
      lat: raw.lat || null,
      lng: raw.lng || null,
      event_type: eventType,
      distances,
      registration_url: raw.registration_url || null,
      regulamin_url: raw.regulamin_url || null,
      registration_deadline: raw.registration_deadline || null,
      price_from: raw.price_from || null,
      price_to: raw.price_to || null,
      website: raw.website || null,
      source: raw.source,
      source_id: raw.source_id,
      source_url: raw.source_url || null,
      source_links: links,
      status: 'pending',
      scraped_at: now,
      last_verified_at: now,
    }
```

- [ ] **Step 2: Update `backend/src/scrapers/dedup.js`**

In `PROTECTED_FIELDS` (~line 16-21): remove fields that no longer exist in calendar_events:
```js
const PROTECTED_FIELDS = new Set([
  'id', 'created_at', 'status', 'enriched_at', 'leszyrun_event_id',
  'registration_deadline', 'price_from', 'price_to',
])
```

In `SCRAPER_FIELDS` (~line 24-28): replace `end_date` with `registration_deadline`, remove `is_night`/`is_charity`, add `regulamin_url`:
```js
const SCRAPER_FIELDS = [
  'name', 'date', 'registration_deadline', 'location', 'voivodeship',
  'lat', 'lng', 'event_type', 'distances',
  'registration_url', 'regulamin_url', 'website',
  'price_from', 'price_to',
  'is_kids',
]
```

- [ ] **Step 3: Update `backend/src/scrapers/normalizer.js`**

At ~line 313, change `end_date` to `registration_deadline`:
```js
    registration_deadline: raw.end_date ? parseDate(raw.end_date) : (raw.registration_deadline ? parseDate(raw.registration_deadline) : null),
```

Remove `is_night` and `is_charity` lines (~325-326). Add `price_from`/`price_to`:
```js
    price_from: raw.price_from || null,
    price_to: raw.price_to || null,
    website: raw.website || null,
    source: raw.source,
```

- [ ] **Step 4: Update `backend/src/scrapers/sources/dostartu.js`**

At line 156, rename `end_date` key:
```js
      registration_deadline: ev.endDate ? ev.endDate.split('T')[0] : null,
```

- [ ] **Step 5: Update `backend/scripts/run-dedup.js`**

At line 28, replace `'end_date'` with `'registration_deadline'` in the fields array.

At line 174, replace `'end_date'` with `'registration_deadline'` in the merge fields array.

- [ ] **Step 6: Commit**

```bash
git add backend/src/scrapers/ backend/scripts/run-dedup.js
git commit -m "refactor: rename end_date to registration_deadline, remove is_night/is_charity, add price/regulamin to publish"
```

---

### Task 4: Update backend API and scripts for dropped columns

**Files:**
- Modify: `backend/src/routes/calendarEvents.js` (line 19)
- Modify: `backend/scripts/publish-event-pages.js` (line 144)

- [ ] **Step 1: Update `backend/src/routes/calendarEvents.js`**

At line 19 in the duplicates endpoint `.select()`, remove `is_night, is_charity` and add `regulamin_url, registration_deadline`:
```js
        .select('id, name, date, location, voivodeship, source, source_id, registration_url, regulamin_url, registration_deadline, source_url, event_type, distances, price_from, price_to, lat, lng')
```

- [ ] **Step 2: Update `backend/scripts/publish-event-pages.js`**

At line 144, replace `end_date: event.end_date || null,` with:
```js
      registration_deadline: event.registration_deadline || null,
      regulamin_url: event.regulamin_url || null,
      price_from: event.price_from || null,
      price_to: event.price_to || null,
```

- [ ] **Step 3: Update `public/scripts/generate-event-pages.js`**

At lines 67-68, remove the `end_date` JSON-LD block:
```js
  // DELETE these lines:
  if (event.end_date) {
    ld.endDate = event.end_date.slice(0, 10)
  }
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/calendarEvents.js backend/scripts/publish-event-pages.js public/scripts/generate-event-pages.js
git commit -m "fix: update API, publish-event-pages, generate-event-pages for schema changes"
```

---

### Task 5: Update EventInfoGrid and EventPage for dropped columns

**Files:**
- Modify: `public/src/components/EventInfoGrid.jsx` (lines 19-24, 61-72)
- Modify: `public/src/pages/EventPage.jsx` (line 75)

- [ ] **Step 1: Update `public/src/components/EventInfoGrid.jsx`**

Remove the `end_date` block (lines 19-24). Replace the entire date cell logic with just:
```js
  if (event.date) {
    const start = new Date(event.date).toLocaleDateString('pl-PL', {
      day: 'numeric', month: 'long', year: 'numeric',
    })
    cells.push({ label: 'Data', value: start })
  }
```

Remove the `max_participants` block (lines 61-62):
```js
  if (event.max_participants != null) {
    cells.push({ label: 'Max. uczestników', value: event.max_participants.toLocaleString('pl-PL') })
  }
```

Remove the `elevation_gain_m` block (lines 66-67):
```js
  if (event.elevation_gain_m != null) {
    cells.push({ label: 'Przewyższenie', value: `${event.elevation_gain_m.toLocaleString('pl-PL')} m` })
  }
```

Remove the `surface` block (lines 71-72):
```js
  if (event.surface) {
    cells.push({ label: 'Nawierzchnia', value: event.surface })
  }
```

- [ ] **Step 2: Update `public/src/pages/EventPage.jsx`**

Remove line 75:
```js
  if (event.end_date) ld.endDate = event.end_date
```

- [ ] **Step 3: Commit**

```bash
git add public/src/components/EventInfoGrid.jsx public/src/pages/EventPage.jsx
git commit -m "fix: remove end_date and dropped columns from event display"
```

---

### Task 6: Create DraggableMap component

**Files:**
- Create: `public/src/components/DraggableMap.jsx`

- [ ] **Step 1: Create the component**

```jsx
import { useState, useRef, useEffect } from 'react'
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const markerIcon = new L.Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  shadowSize: [41, 41],
})

function DraggablePin({ position, onMove }) {
  const markerRef = useRef(null)

  useMapEvents({
    click(e) {
      onMove(e.latlng.lat, e.latlng.lng)
    },
  })

  return (
    <Marker
      position={position}
      icon={markerIcon}
      draggable
      ref={markerRef}
      eventHandlers={{
        dragend() {
          const m = markerRef.current
          if (m) {
            const { lat, lng } = m.getLatLng()
            onMove(lat, lng)
          }
        },
      }}
    />
  )
}

function RecenterMap({ lat, lng }) {
  const map = useMapEvents({})
  const prevRef = useRef(null)

  useEffect(() => {
    const key = `${lat},${lng}`
    if (lat && lng && key !== prevRef.current) {
      prevRef.current = key
      map.setView([lat, lng], map.getZoom())
    }
  }, [lat, lng, map])

  return null
}

/**
 * Leaflet map with a draggable pin. User can click or drag to set position.
 *
 * @param {{ lat: number|null, lng: number|null, onChange: (lat: number, lng: number) => void, height?: number }} props
 */
export default function DraggableMap({ lat, lng, onChange, height = 180 }) {
  const hasCoords = lat != null && lng != null
  const center = hasCoords ? [Number(lat), Number(lng)] : [52.0, 19.5] // center of Poland
  const zoom = hasCoords ? 13 : 6

  return (
    <div>
      <div className="border border-apex-border overflow-hidden relative" style={{ height }}>
        <MapContainer
          center={center}
          zoom={zoom}
          scrollWheelZoom={true}
          style={{ height: '100%', width: '100%' }}
          attributionControl={true}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <RecenterMap lat={lat} lng={lng} />
          {hasCoords && (
            <DraggablePin
              position={[Number(lat), Number(lng)]}
              onMove={(newLat, newLng) => onChange(newLat, newLng)}
            />
          )}
        </MapContainer>
        {hasCoords && (
          <div className="absolute bottom-1.5 right-2 font-mono text-[10px] text-apex-yellow bg-apex-bg/80 px-1.5 py-0.5 z-[1000] pointer-events-none">
            {Number(lat).toFixed(4)}°N, {Number(lng).toFixed(4)}°E
          </div>
        )}
      </div>
      <div className="font-mono text-[10px] text-apex-muted mt-1">
        {hasCoords ? 'Kliknij lub przesuń pinezkę, aby skorygować lokalizację' : 'Podaj miasto, aby zobaczyć mapę'}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/components/DraggableMap.jsx
git commit -m "feat: add DraggableMap component with draggable pin"
```

---

### Task 7: Update DodajWydarzenie with expandable extras section

**Files:**
- Modify: `public/src/pages/DodajWydarzenie.jsx`

- [ ] **Step 1: Add state for new fields and the expanded toggle**

In the state declarations (around line 38-48), add:

```js
  const [showExtras, setShowExtras] = useState(false)
  const [website, setWebsite] = useState('')
  const [regulaminUrl, setRegulaminUrl] = useState('')
  const [priceFrom, setPriceFrom] = useState('')
  const [priceTo, setPriceTo] = useState('')
  const [regDeadline, setRegDeadline] = useState('')
  const [mapLat, setMapLat] = useState(null)
  const [mapLng, setMapLng] = useState(null)
  const [mapMoved, setMapMoved] = useState(false)
```

- [ ] **Step 2: Add lazy import for DraggableMap**

At the top of the file, add:
```js
import { lazy, Suspense } from 'react'
const DraggableMap = lazy(() => import('../components/DraggableMap.jsx'))
```

Update the existing `import { useState } from 'react'` to `import { useState, lazy, Suspense } from 'react'`.

- [ ] **Step 3: Update geocoding to also set map pin**

In the `handleSubmit` function, after the Nominatim geocode succeeds (~line 99-103), add:
```js
        if (geoResults.length > 0) {
          lat = parseFloat(geoResults[0].lat)
          lng = parseFloat(geoResults[0].lon)
          if (!mapMoved) {
            setMapLat(lat)
            setMapLng(lng)
          }
        }
```

Also, trigger geocode when city field loses focus so the map updates in real time. Add a `geocodeCity` function:
```js
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
```

On the city input, add `onBlur`:
```js
<input type="text" value={form.location} onChange={set('location')}
  onBlur={() => geocodeCity(form.location)}
  className={inputClass} placeholder="np. Zakopane" />
```

- [ ] **Step 4: Update submit payload**

In `handleSubmit`, update the Supabase insert to use map coords if user moved pin, and include new fields:
```js
    // Use map pin position if user adjusted it, otherwise auto-geocode
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
```

- [ ] **Step 5: Add the expandable extras section in the JSX**

After the "Link do wydarzenia" input and before the error/submit button, add:

```jsx
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
```

- [ ] **Step 6: Test manually**

Open `http://localhost:3002/kalendarz/dodaj`:
1. Fill in name, date, city — verify core fields work as before
2. Click "Więcej szczegółów" — verify section expands
3. Type a city, tab out — verify map pin appears at geocoded location
4. Drag pin — verify coordinates update
5. Fill in price, deadline, URLs
6. Submit — verify all fields appear in Supabase `calendar_events` with `status: 'pending'`

- [ ] **Step 7: Commit**

```bash
git add public/src/pages/DodajWydarzenie.jsx
git commit -m "feat: add expandable extras section to DodajWydarzenie with map, price, deadline"
```

---

### Task 8: Update ReportEventModal with new fields

**Files:**
- Modify: `public/src/components/ReportEventModal.jsx`

- [ ] **Step 1: Add lazy import for DraggableMap**

At top of file:
```js
import { useState, lazy, Suspense } from 'react'
```

And add:
```js
const DraggableMap = lazy(() => import('./DraggableMap.jsx'))
```

- [ ] **Step 2: Update FIELDS array**

Replace the existing `FIELDS` array with:
```js
const FIELDS = [
  { value: 'name', label: 'Nazwa' },
  { value: 'date', label: 'Data' },
  { value: 'location', label: 'Miejsce' },
  { value: 'voivodeship', label: 'Województwo' },
  { value: 'distances', label: 'Dystanse' },
  { value: 'event_type', label: 'Typ wydarzenia' },
  { value: 'registration_url', label: 'Link do zapisów' },
  { value: 'website', label: 'Strona wydarzenia' },
  { value: 'regulamin_url', label: 'Link do regulaminu' },
  { value: 'price_from', label: 'Cena od (zł)' },
  { value: 'price_to', label: 'Cena do (zł)' },
  { value: 'registration_deadline', label: 'Termin zapisów' },
  { value: 'location_map', label: 'Lokalizacja na mapie' },
  { value: 'cancelled', label: 'Wydarzenie odwołane' },
]
```

- [ ] **Step 3: Update `getCurrentValue` function**

Add cases for the new fields:
```js
function getCurrentValue(event, field) {
  if (field === 'cancelled') return event.status === 'cancelled' ? 'Tak' : 'Nie'
  if (field === 'distances') return event.distances?.join(', ') || '—'
  if (field === 'event_type') return event.event_type?.join(', ') || '—'
  if (field === 'price_from') return event.price_from != null ? `${event.price_from} zł` : '—'
  if (field === 'price_to') return event.price_to != null ? `${event.price_to} zł` : '—'
  if (field === 'registration_deadline') {
    if (!event.registration_deadline) return '—'
    return new Date(event.registration_deadline).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }
  if (field === 'location_map') {
    return (event.lat != null && event.lng != null)
      ? `${Number(event.lat).toFixed(4)}, ${Number(event.lng).toFixed(4)}`
      : 'brak'
  }
  return event[field] || '—'
}
```

- [ ] **Step 4: Update `SuggestedInput` component**

Add cases for the new field types. Insert before the final `return` at the end of the function:

```js
  if (field === 'website' || field === 'regulamin_url') {
    return <input type="url" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} placeholder="https://..." />
  }

  if (field === 'price_from' || field === 'price_to') {
    return <input type="number" min="0" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} placeholder="np. 80" />
  }

  if (field === 'registration_deadline') {
    return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} />
  }

  if (field === 'location_map') {
    const [lat, lng] = value ? value.split(',').map(Number) : [null, null]
    const hasVal = lat != null && lng != null && !isNaN(lat) && !isNaN(lng)
    const initLat = hasVal ? lat : (event.lat != null ? Number(event.lat) : null)
    const initLng = hasVal ? lng : (event.lng != null ? Number(event.lng) : null)
    return (
      <Suspense fallback={<div className="border border-apex-border bg-apex-surface" style={{ height: 150 }} />}>
        <DraggableMap
          lat={initLat}
          lng={initLng}
          height={150}
          onChange={(newLat, newLng) => onChange(`${newLat.toFixed(6)},${newLng.toFixed(6)}`)}
        />
      </Suspense>
    )
  }
```

Note: The `SuggestedInput` component needs access to `event` for the `location_map` initial position. Update the component signature from `function SuggestedInput({ field, value, onChange })` to `function SuggestedInput({ field, value, onChange, event })`.

Also update the call site in the JSX (~line 160):
```jsx
<SuggestedInput field={field} value={suggestedValue} onChange={setSuggestedValue} event={event} />
```

- [ ] **Step 5: Test manually**

Open an event page at `http://localhost:3002/kalendarz/<slug>`, click "Zgłoś poprawkę":
1. Select "Strona wydarzenia" — verify URL input appears
2. Select "Cena od (zł)" — verify number input appears
3. Select "Termin zapisów" — verify date picker appears
4. Select "Lokalizacja na mapie" — verify map with draggable pin appears at event's location
5. Drag pin, submit — verify `suggested_value` contains lat,lng string
6. Check Supabase `calendar_event_reports` table for the new report

- [ ] **Step 6: Commit**

```bash
git add public/src/components/ReportEventModal.jsx
git commit -m "feat: add new fields to ReportEventModal (website, regulamin, price, deadline, map)"
```

---

### Task 9: Verify end-to-end and clean up

- [ ] **Step 1: Run publish script dry-run to verify no errors**

```bash
cd backend && node --env-file=../.env scripts/run-publish.js
```

Expected: No crashes. Should show `created=0 skipped=N` (since all events already published).

- [ ] **Step 2: Verify event pages still render**

Open `http://localhost:3002/kalendarz` — click into any event page. Verify:
- No console errors
- EventInfoGrid shows data (no end_date, no max_participants, etc.)
- Map still renders
- Regulamin button appears if the event has one

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: final cleanup for community forms enrichment"
```
