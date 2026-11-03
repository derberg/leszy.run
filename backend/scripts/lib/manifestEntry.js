// Builds one entry of public/public/kalendarz/.manifest.json.
//
// Extracted from publish-event-pages.js so the zero-price contract is testable:
// see test/manifestFreePrice.test.js.
//
// Numeric columns use `??`, never `||`. A free race stores price_from = 0, and
// `||` treats that as absent — which not only hid the price but emptied the
// /listy/darmowe landing pages, since generate-landing-pages.js selects them
// from this manifest with `price_from !== 0`.

export function buildManifestEntry(event) {
  return {
    id: event.id,
    name: event.name,
    date: event.date,
    registration_deadline: event.registration_deadline || null,
    regulamin_url: event.regulamin_url || null,
    price_from: event.price_from ?? null,
    price_to: event.price_to ?? null,
    location: event.location || null,
    voivodeship: event.voivodeship || null,
    lat: event.lat ?? null,
    lng: event.lng ?? null,
    distances: event.distances || null,
    event_type: event.event_type || null,
    registration_url: event.registration_url || null,
    website: event.website || null,
    is_kids: event.is_kids ?? null,
    status: event.status || null,
    // Read by the /kalendarz calendar (public/src/lib/calendarData.js): the "Dodane"
    // filter and the leszy.run badge. Neither is drawn on the share image.
    created_at: event.created_at || null,
    leszyrun_event_id: event.leszyrun_event_id || null,
  }
}

// Fields that change what the share image shows. A change limited to the others must not
// regenerate it: adding created_at to every entry would otherwise redraw 3,000 images.
export const NOT_ON_SHARE_IMAGE = ['created_at', 'leszyrun_event_id']

/** The entry as the share-image diff sees it. */
export function shareImageView(entry) {
  if (!entry) return entry
  const view = { ...entry }
  for (const f of NOT_ON_SHARE_IMAGE) delete view[f]
  return view
}
