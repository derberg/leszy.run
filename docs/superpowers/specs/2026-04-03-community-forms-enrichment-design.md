# Community Forms Enrichment + Schema Cleanup

**Date:** 2026-04-03
**Status:** Approved

## Summary

Expand the DodajWydarzenie (add event) form and Zgłoś poprawkę (report correction) modal to support all data fields displayed on individual event pages. Includes schema changes to clean up unused columns and add missing ones.

## Problem

The event detail page (`EventPage.jsx`, `EventInfoGrid.jsx`) displays fields like price, registration deadline, regulamin URL, and map location — but neither the community submission form nor the correction report modal lets users provide or fix this data. Several `calendar_events` columns (elevation_gain_m, surface, max_participants) have zero data and no source, so they should be removed.

## Schema Changes

### calendar_events (Supabase migration)

**Drop columns:**
- `max_participants` (0 rows with data)
- `surface` (0 rows with data)
- `elevation_gain_m` (0 rows with data)
- `end_date` (1 row with data — replaced by `registration_deadline` which already exists)
- `is_night` (boolean — redundant, event_type array already has 'nocny')
- `is_charity` (boolean — redundant, event_type array already has 'charytatywny')
- `is_recurring`, `recurring_event_id`, `edition_number` (unused recurring event system)

**Add columns:**
- `regulamin_url` text nullable

### scraper_all (Supabase migration)

**Rename:**
- `end_date` → `registration_deadline` (date)

**Add columns:**
- `price_from` integer nullable
- `price_to` integer nullable

### Code references to update after schema changes

Any code referencing dropped columns or renamed columns needs updating:

**end_date → registration_deadline (scraper_all rename):**
- `backend/src/scrapers/index.js` — `publishToCalendar()` maps end_date; `mergeIntoScraperAll()` may reference it
- `backend/src/scrapers/dedup.js` — cross-source matching may use end_date
- `backend/src/scrapers/normalizer.js` — may parse/set end_date
- `backend/src/scrapers/sources/dostartu.js` — scrapes end_date
- `backend/scripts/run-dedup.js` — may reference end_date
- `backend/scripts/publish-event-pages.js` — generates static pages, may include end_date
- `public/scripts/generate-event-pages.js` — same as above

**end_date removal from calendar_events:**
- `public/src/components/EventInfoGrid.jsx` — remove end_date display (lines 19-24)
- `public/src/pages/EventPage.jsx` — remove end_date from JSON-LD `buildJsonLd()` (ld.endDate)

**New fields to wire up:**
- `backend/src/scrapers/index.js` — `publishToCalendar()`: map regulamin_url, registration_deadline, price_from, price_to
- `backend/src/routes/calendarEvents.js` — allow new fields in PATCH/POST

## DodajWydarzenie Form Changes

**File:** `public/src/pages/DodajWydarzenie.jsx`

### Core section (always visible)
No changes to field list — same as current:
- Nazwa wydarzenia * (required)
- Data * (required)
- Miasto * (required) + Województwo (optional) — side by side
- Dystanse (toggle buttons + custom)
- Typ wydarzenia (toggle buttons)
- Link do zapisów (URL input)

### New: "Więcej szczegółów" expandable section
Collapsed by default. Toggle button with "▼ Więcej szczegółów" label and "opcjonalne" hint.

Fields inside:
1. **Strona wydarzenia** — URL input (`website`)
2. **Link do regulaminu** — URL input (`regulamin_url`)
3. **Cena od / Cena do** — two number inputs side by side, integer PLN (`price_from`, `price_to`)
4. **Termin zapisów** — date input (`registration_deadline`)
5. **Dokładna lokalizacja** — Leaflet map with draggable pin
   - Initial position: auto-geocoded from city name (existing Nominatim call)
   - User can drag pin to adjust
   - Coordinates displayed in corner of map
   - Helper text: "Pozycja startowa wyznaczana automatycznie z nazwy miasta. Skoryguj jeśli to potrzebne."
   - Submitted as `lat`/`lng` fields (overrides auto-geocode if user moved the pin)
   - Lazy-loaded (same pattern as EventMap on event pages)

### Submit payload
Existing fields + new optional fields:
```js
{
  name, date, location, voivodeship, distances, event_type, registration_url,
  // new:
  website, regulamin_url, price_from, price_to, registration_deadline,
  lat, lng,  // from map pin or auto-geocode
  source: 'community', status: 'pending'
}
```

## Zgłoś poprawkę Modal Changes

**File:** `public/src/components/ReportEventModal.jsx`

### Updated FIELDS array
Add new entries to the field dropdown:
```js
const FIELDS = [
  // existing:
  { value: 'name', label: 'Nazwa' },
  { value: 'date', label: 'Data' },
  { value: 'location', label: 'Miejsce' },
  { value: 'voivodeship', label: 'Województwo' },
  { value: 'distances', label: 'Dystanse' },
  { value: 'event_type', label: 'Typ wydarzenia' },
  { value: 'registration_url', label: 'Link do zapisów' },
  // new:
  { value: 'website', label: 'Strona wydarzenia' },
  { value: 'regulamin_url', label: 'Link do regulaminu' },
  { value: 'price_from', label: 'Cena od' },
  { value: 'price_to', label: 'Cena do' },
  { value: 'registration_deadline', label: 'Termin zapisów' },
  { value: 'location_map', label: 'Lokalizacja na mapie' },
  // existing:
  { value: 'cancelled', label: 'Wydarzenie odwołane' },
]
```

### New SuggestedInput variants
- `website`, `regulamin_url` — URL input (same as existing `registration_url`)
- `price_from`, `price_to` — number input with "zł" placeholder
- `registration_deadline` — date input
- `location_map` — Leaflet map with draggable pin
  - Centers on event's current lat/lng (or city-geocoded fallback)
  - User drags pin to correct location
  - Submitted `suggested_value` = `"lat,lng"` string
  - `old_value` shows current `"lat,lng"` or "brak"
  - Lazy-loaded

### getCurrentValue updates
- `price_from` / `price_to` — show current value + " zł" or "—"
- `registration_deadline` — format as date or "—"
- `website` / `regulamin_url` — show URL or "—"
- `location_map` — show `"lat, lng"` or "brak"

## EventInfoGrid Changes

**File:** `public/src/components/EventInfoGrid.jsx`

- Remove `end_date` display (lines 19-24 referencing `event.end_date`)
- Add `regulamin_url` — not in the grid, but ensure EventPage shows the button (already does conditionally)
- Keep `registration_deadline` display (already exists)
- Keep `price_from`/`price_to` display (already exists)
- Remove references to dropped columns if any

## EventPage Changes

**File:** `public/src/pages/EventPage.jsx`

- Remove `end_date` from JSON-LD `buildJsonLd()` (the `ld.endDate` line)
- `regulamin_url` button already exists in CTA section (line 349-357), reads `event.regulamin_url` — will work once column is added, no code change needed

## Publish Script Changes

**File:** `backend/src/scrapers/index.js` — `publishToCalendar()`

Current mapping builds a `row` object from scraper_all data. Add:
```js
regulamin_url: raw.regulamin_url || null,
registration_deadline: raw.registration_deadline || null,  // was end_date
price_from: raw.price_from || null,
price_to: raw.price_to || null,
```

Remove `end_date` mapping if present.

## Backend API Changes

**File:** `backend/src/routes/calendarEvents.js`

Ensure PATCH endpoint accepts new fields: `regulamin_url`, `price_from`, `price_to`, `registration_deadline`. Check that the moderation page (Moderation.jsx) can edit these fields too — may need updates to the EditableEvent component in the admin frontend.

## Out of Scope

- Enrichment scripts extracting price/deadline from regulamin PDFs (future enhancement)
- Scraper changes to populate price_from/price_to in scraper_all (no source currently provides price)
- Admin moderation form field additions (can be done separately)
