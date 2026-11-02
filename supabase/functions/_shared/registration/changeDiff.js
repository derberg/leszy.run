// What „Opublikuj zmiany” changes, and whom the optional change notice is
// for. Plain ESM, no runtime APIs: runs in Deno (publish-registration-event)
// and in the browser (the confirmation dialog).
//
// changeDiff(live, pending) compares the staged payload (the validated
// snake_case sections of registration_pending_changes.payload) with the live
// rows and lists every value that would change:
//   live = { settings, competitions, officeHours, ageGroups, kidsGroups, consents }
//     settings      the registration_settings row
//     competitions  competitions rows, each with `price` (grosze of the fixed
//                   tier, or null) and, for tiered pricing, `prices` ({ tierId: grosze })
//     tiers         price_tiers rows (id, ends_on) in registration_raw's order
//     extras        extras (snake_case, as the extras section stages them: id, name,
//                   price, order_until, category_ids, variants [{ id, label, stock }])
//     officeHours   office_hours rows (starts_at, ends_at, note)
//     ageGroups, kidsGroups, consents  their rows (consents: custom ones are compared)
//     payout        { mode, ready } of the event's payout account (eventPayout.js),
//                   carried into mergedChecklistInput; never the account itself
// → [{ field: '<section>.<key>', label, before, after, categoryId? }]
//
// noticeAudience(diff) → { all, categoryIds }: a change of date or place is
// for everyone registered; a start time or distance only for that competition.
// noticeRows(diff) → those rows, for the notice's suggested text (no pin).
//
// mergedChecklistInput(live, pending) → what publishChecklist() reads, for the
// event as it will be once the staged changes are applied.

const SETTINGS_LABELS = {
  basics: {
    name: 'Nazwa', event_date: 'Data zawodów', first_start_time: 'Godzina pierwszego startu',
    opens_at: 'Otwarcie zapisów', closes_at: 'Koniec zapisów', is_charity: 'Wydarzenie charytatywne',
    charity_goal: 'Cel zbiórki', charity_url: 'Strona celu', charity_percent: 'Procent dochodu na cel', description: 'Opis wydarzenia', website_url: 'Strona wydarzenia', donations_enabled: 'Wpłaty na cel', town_label: 'Miejscowość',
    town_area: 'Gmina i województwo', place_details: 'Miejsce startu', lat: 'Pinezka (szerokość)',
    lng: 'Pinezka (długość)', contact_email: 'Adres kontaktowy', regulamin_kind: 'Rodzaj regulaminu', regulamin_url: 'Regulamin (link)',
    regulamin_upload_id: 'Regulamin (PDF)', poster_upload_id: 'Plakat',
  },
  office: {
    office_same_as_event: 'Biuro w miejscu startu', office_address: 'Adres biura', office_notes: 'Uwagi do biura',
    office_lat: 'Pinezka biura (szerokość)', office_lng: 'Pinezka biura (długość)',
  },
  competitions: { pricing_mode: 'Rodzaj opłaty' },
  categories: { age_reckoning: 'Liczenie wieku' },
  timing: { timing_company: 'Firma pomiaru czasu', results_url: 'Wyniki', live_results_url: 'Wyniki na żywo' },
  form: { form_fields: 'Pola formularza' },
  payments: {
    payment_window_hours: 'Czas na opłacenie zgłoszenia', transfer_enabled: 'Przekazanie pakietu',
    transfer_until: 'Przekazanie możliwe do',
  },
}

// Values shown in words rather than as stored.
const WINDOW_WORDS = { 24: '24 godziny', 168: '7 dni', 336: '14 dni' }
const VALUE_WORDS = {
  'payments.payment_window_hours': (v) => WINDOW_WORDS[v] ?? (v == null ? null : `${v} godz.`),
  'payments.transfer_enabled': (v) => (v === true ? 'tak' : 'nie'),
}
// The payment window as the organizer chose it: „do końca zapisów” hides the hours behind it.
const windowWords = (s) => (s.payment_window_until_close === true
  ? 'do końca zapisów'
  : VALUE_WORDS['payments.payment_window_hours'](s.payment_window_hours ?? null))

const ITEM_LABELS = {
  name: 'nazwa', discipline: 'dyscyplina', distance_label: 'dystans', start_time: 'godzina startu',
  capacity: 'limit miejsc', min_age: 'wiek od', max_age: 'wiek do', is_kids: 'konkurencja dla dzieci',
  timed: 'pomiar czasu', gpx_upload_id: 'trasa (GPX)', price: 'opłata', kind: 'rodzaj',
  team_min: 'skład od', team_max: 'skład do',
}

const NOTICE_ALL = new Set(['basics.event_date', 'basics.first_start_time', 'basics.town_label',
  'basics.place_details', 'basics.lat', 'basics.lng'])
const NOTICE_COMPETITION = new Set(['competitions.start_time', 'competitions.distance_label'])

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T/

/** A stored or staged scalar in one comparable spelling: '10:00:00' → '10:00', timestamps → ISO. */
function norm(v) {
  if (v === undefined || v === '') return null
  if (typeof v === 'string' && TIME_RE.test(v)) return v.slice(0, 5)
  if (typeof v === 'string' && TIMESTAMP_RE.test(v) && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/** Objects and lists compare by content, keys sorted. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  return norm(v)
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))

// Lists, in the shape the staged payload holds them, without ids or order fields.
const warsawParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
function warsaw(iso) {
  const p = Object.fromEntries(warsawParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}
// A note is part of the row: changing only the note is a change.
const withNote = (row, note) => (note ? { ...row, note } : row)
const liveHours = (rows = []) => rows
  .map((h) => withNote({ date: warsaw(h.starts_at).date, from: warsaw(h.starts_at).time, to: warsaw(h.ends_at).time }, h.note))
  .sort((a, b) => `${a.date}${a.from}`.localeCompare(`${b.date}${b.from}`))
const stagedHours = (rows = []) => rows
  .map((h) => withNote({ date: h.date, from: h.from, to: h.to }, h.note))
  .sort((a, b) => `${a.date}${a.from}`.localeCompare(`${b.date}${b.from}`))
const ageGroups = (rows = []) => rows.map(({ category_id, gender, label, min_age, max_age }) => ({ category_id, gender, label, min_age, max_age }))
const kidsGroups = (rows = []) => rows.map(({ category_id, label, birth_year_from, birth_year_to, gender, distance_label }) =>
  ({ category_id, label, birth_year_from, birth_year_to, gender, distance_label }))
// Whom a consent applies to is part of it: switching minors-only alone is a change. Live rows
// carry minors_only, staged ones minorsOnly.
const customConsents = (rows = []) => rows.filter((k) => (k.kind ?? 'custom') === 'custom')
  .map((k) => ((k.minorsOnly ?? k.minors_only) === true ? `${k.text} (tylko przy dziecku)` : k.text))

const LISTS = {
  'office.hours': { label: 'Godziny biura', live: (l) => liveHours(l.officeHours), staged: stagedHours },
  'categories.age_groups': { label: 'Kategorie wiekowe', live: (l) => ageGroups(l.ageGroups), staged: ageGroups },
  'categories.kids_groups': { label: 'Grupy dzieci', live: (l) => kidsGroups(l.kidsGroups), staged: kidsGroups },
  'form.consents': { label: 'Zgody', live: (l) => customConsents(l.consents), staged: customConsents },
}

const shown = (v) => norm(v)

// ---------------------------------------------------------------- tiers and extras

/** 6000 → '60 zł', 6050 → '60,50 zł' */
function money(grosze) {
  if (grosze == null) return '—'
  const zl = grosze / 100
  return `${Number.isInteger(zl) ? zl : zl.toFixed(2).replace('.', ',')} zł`
}
/** '2026-11-15' → '15.11' */
const dm = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d}.${m}` }
const tierWords = (tiers) => tiers.map((t) => (t.ends_on == null ? 'do końca zapisów' : `do ${dm(t.ends_on)}`)).join(' · ')
const tierKey = (t, i) => t.id ?? `new:${i}`

// One row for the tier dates, one per competition whose amounts change, in tier order.
function tierDiff(live, value, out) {
  const before = live.tiers ?? []
  const after = value.tiers ?? []
  const wasTiered = live.settings?.pricing_mode === 'tiered'
  if (!wasTiered || tierWords(before) !== tierWords(after)) {
    out.push({ field: 'competitions.tiers', label: 'Progi cenowe', before: wasTiered ? tierWords(before) : null, after: tierWords(after) })
  }
  const byId = new Map((live.competitions ?? []).map((c) => [c.category_id, c]))
  for (const item of value.items ?? []) {
    const c = byId.get(item.category_id)
    if (!c) continue
    const was = wasTiered ? before.map((t) => money(c.prices?.[t.id])).join(' · ') : null
    const now = after.map((t, i) => money(item.prices?.[tierKey(t, i)])).join(' · ')
    if (was === now) continue
    out.push({ field: 'competitions.prices', label: `${c.name}: opłaty`, before: was, after: now, categoryId: c.category_id })
  }
}

// Dodatki as one row: each extra as „name: price, do d.m (variant: stock, …)”.
const extraWords = (items = []) => items.map((x) =>
  `${x.name}: ${money(x.price)}, do ${dm(x.order_until)} (${(x.variants ?? []).map((v) => `${v.label}: ${v.stock}`).join(', ')})`)

function competitionDiff(live, value, out) {
  const byId = new Map((live.competitions ?? []).map((c) => [c.category_id, c]))
  for (const item of value.items ?? []) {
    if (!item.category_id) {
      out.push({ field: 'competitions.new', label: 'Nowa konkurencja', before: null, after: item.name })
      continue
    }
    const c = byId.get(item.category_id)
    if (!c) continue
    for (const [key, word] of Object.entries(ITEM_LABELS)) {
      if (!(key in item)) continue
      if (key === 'price' && (value.pricing_mode ?? live.settings?.pricing_mode) !== 'fixed') continue
      if (same(c[key] ?? null, item[key])) continue
      out.push({ field: `competitions.${key}`, label: `${c.name}: ${word}`, before: shown(c[key] ?? null), after: shown(item[key]), categoryId: c.category_id })
    }
    if ('hidden' in item && item.hidden !== (c.hidden_at != null)) {
      out.push({
        field: 'competitions.hidden', label: `${c.name}: widoczność`,
        before: c.hidden_at != null ? 'ukryta' : 'widoczna', after: item.hidden ? 'ukryta' : 'widoczna', categoryId: c.category_id,
      })
    }
  }
}

// The staged map holds every team competition, so only the ones that change are rows. A
// competition staged back to individual in the same round is skipped at publish, and here.
function legOrderDiff(live, map, pending, out) {
  const kinds = new Map((pending?.competitions?.items ?? []).map((i) => [i.category_id, i.kind]))
  for (const c of live.competitions ?? []) {
    if (!(c.category_id in map) || (kinds.get(c.category_id) ?? c.kind) !== 'team') continue
    const before = c.leg_order_enabled === true
    if (map[c.category_id] === before) continue
    out.push({ field: 'form.leg_order', label: `${c.name}: kolejność zmian`, before, after: map[c.category_id], categoryId: c.category_id })
  }
}

/**
 * @param {object} live see the module comment
 * @param {object|null} pending registration_pending_changes.payload
 * @returns {{ field: string, label: string, before: any, after: any, categoryId?: string }[]}
 */
export function changeDiff(live, pending) {
  const out = []
  const settings = live.settings ?? {}
  for (const [section, value] of Object.entries(pending ?? {})) {
    if (!value || typeof value !== 'object') continue
    // One row for the payment window, whichever of its two columns is staged.
    if (section === 'payments') {
      const before = windowWords(settings)
      const after = windowWords({ ...settings, ...value })
      if (before !== after) {
        out.push({ field: 'payments.payment_window_hours', label: SETTINGS_LABELS.payments.payment_window_hours, before, after })
      }
      for (const key of ['transfer_enabled', 'transfer_until']) {
        if (!(key in value) || same(settings[key] ?? null, value[key])) continue
        const field = `payments.${key}`
        const words = VALUE_WORDS[field] ?? shown
        out.push({ field, label: SETTINGS_LABELS.payments[key], before: words(settings[key] ?? null), after: words(value[key]) })
      }
      continue
    }
    if (section === 'extras') {
      const before = extraWords(live.extras)
      const after = extraWords(value.items)
      if (!same(before, after)) out.push({ field: 'extras.items', label: 'Dodatki', before, after })
      continue
    }
    for (const [key, after] of Object.entries(value)) {
      const field = `${section}.${key}`
      if (section === 'competitions' && key === 'items') { competitionDiff(live, value, out); continue }
      if (section === 'competitions' && key === 'tiers') {
        if (value.pricing_mode === 'tiered') tierDiff(live, value, out)
        continue
      }
      if (field === 'form.leg_order') { legOrderDiff(live, after, pending, out); continue }
      if (LISTS[field]) {
        const { label, live: fromLive, staged } = LISTS[field]
        const before = fromLive(live)
        const next = staged(after)
        if (!same(before, next)) out.push({ field, label, before, after: next })
        continue
      }
      const label = SETTINGS_LABELS[section]?.[key]
      if (!label) continue
      if (same(settings[key] ?? null, after)) continue
      const words = VALUE_WORDS[field] ?? shown
      out.push({ field, label, before: words(settings[key] ?? null), after: words(after) })
    }
  }
  return out
}

/** @returns {{ all: boolean, categoryIds: string[] }} */
export function noticeAudience(diff) {
  const all = diff.some((d) => NOTICE_ALL.has(d.field))
  const categoryIds = [...new Set(diff.filter((d) => NOTICE_COMPETITION.has(d.field) && d.categoryId).map((d) => d.categoryId))]
  return { all, categoryIds }
}

// The pin moves with the place, whose own row already says what changed.
const NOTICE_TEXT_SKIP = new Set(['basics.lat', 'basics.lng'])

/** The rows of a diff the change notice is about, for its suggested text. */
export function noticeRows(diff) {
  return diff.filter((d) => (NOTICE_ALL.has(d.field) || NOTICE_COMPETITION.has(d.field)) && !NOTICE_TEXT_SKIP.has(d.field))
}

const camelKey = (k) => k.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())
const camel = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [camelKey(k), v]))
const LIST_KEYS = new Set(['hours', 'items', 'age_groups', 'kids_groups', 'consents', 'leg_order', 'tiers'])

/**
 * @param {object} live see the module comment
 * @param {object|null} pending registration_pending_changes.payload
 * @returns {{ settings: object, competitions: object[], officeHours: object[], extras: object[], payout?: object }} camelCase
 */
export function mergedChecklistInput(live, pending) {
  const settings = { ...live.settings }
  for (const [section, value] of Object.entries(pending ?? {})) {
    if (section === 'extras') continue
    if (!value || typeof value !== 'object') continue
    for (const [key, v] of Object.entries(value)) if (!LIST_KEYS.has(key)) settings[key] = v
  }
  let competitions = live.competitions ?? []
  const items = pending?.competitions?.items
  if (items) {
    const byId = new Map(competitions.map((c) => [c.category_id, c]))
    competitions = items.map((i) => {
      const base = byId.get(i.category_id) ?? {}
      const { hidden, ...fields } = i
      const hiddenAt = hidden === undefined ? (base.hidden_at ?? null) : (hidden ? 'staged' : null)
      return { ...base, ...fields, hidden_at: hiddenAt }
    })
  }
  const officeHours = pending?.office?.hours ?? live.officeHours ?? []
  // The payout is never staged: it is the live state, { mode, ready } only.
  // The extras the event will have: only their prices matter to the checklist (takesMoney).
  const extras = pending?.extras?.items ?? live.extras ?? []
  // The tiers it will have: a staged competitions section decides (no tiers unless tiered).
  const staged = pending?.competitions
  const tiers = staged ? (staged.pricing_mode === 'tiered' ? (staged.tiers ?? []) : []) : (live.tiers ?? [])
  return { settings: camel(settings), competitions: competitions.map(camel), officeHours, extras, tiers, payout: live.payout }
}
