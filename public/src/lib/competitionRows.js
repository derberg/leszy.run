// The Konkurencje step's rows as pure functions: a row per competition with
// text inputs, the competitions section value the server takes, and the ids
// a save hands back. The rules are the server's own validateSection(),
// imported by relative path so node --test can load this module too.
//
// * A row is sent once it is whole (passes the shared validation). A row the
//   server already has and someone is mid-way through editing sends its last
//   whole value instead, so a half-typed edit never deletes it.
// * After publish every competition is sent, hidden ones included, each
//   with its `hidden` flag: a competition left out of the list would mean
//   deleting it, and the server refuses that (409).
// * Tiered pricing (A3, D7-12): the tiers are shared date columns, the last one
//   open until registration closes, and each row holds one price per column.
//   A column is keyed by `key` in the UI; the section names it by its id, or
//   `new:<index>` for a column the save creates (D7-4).
import { validateSection } from '../../../supabase/functions/_shared/registration/sections.js'
import { warsawToday } from '../../../supabase/functions/_shared/registration/dates.js'
import { MAX_TIERS } from '../../../supabase/functions/_shared/registration/pricing.js'
import { countPl, pluralPl } from './plural.js'

let rowSeq = 0
let tierSeq = 0

/** 6050 → '60,50', 6000 → '60', null → ''. */
export function priceText(grosze) {
  if (grosze == null) return ''
  return grosze % 100 ? (grosze / 100).toFixed(2).replace('.', ',') : String(grosze / 100)
}

const text = (v) => (v == null ? '' : String(v))

/** A row from get-registration-event's competition (camelCase). */
export function competitionRow(c) {
  const row = {
    key: ++rowSeq,
    categoryId: c.categoryId,
    name: c.name ?? '',
    // A kind-less item validates as individual, so a save would flip a team back.
    kind: c.kind ?? 'individual',
    teamMin: text(c.teamMin),
    teamMax: text(c.teamMax),
    discipline: c.discipline ?? 'run',
    distanceLabel: c.distanceLabel ?? '',
    startTime: c.startTime ? c.startTime.slice(0, 5) : '',
    capacity: text(c.capacity),
    minAge: text(c.minAge),
    maxAge: text(c.maxAge),
    isKids: !!c.isKids,
    timed: c.timed !== false,
    gpxUploadId: c.gpxUploadId ?? null,
    price: priceText(c.priceGrosze),
    // Tiered prices by column key (a tier id, or `new:<index>` for a staged column).
    prices: Object.fromEntries(Object.entries(c.prices ?? {}).map(([k, v]) => [k, priceText(v)])),
    hidden: !!c.hiddenAt,
    taken: c.taken ?? 0,
    // Locks kind, price and hiding (get-registration-event, owner/admin): confirmed entries or a
    // live unpaid order. Older payloads without it fall back to confirmed entries.
    inUse: c.inUse ?? (c.taken ?? 0) > 0,
    saved: null,
  }
  row.saved = baseItem(row)
  return row
}

export function newCompetitionRow(over = {}) {
  return {
    key: ++rowSeq, categoryId: null, name: '', kind: 'individual', teamMin: '', teamMax: '', discipline: 'run', distanceLabel: '', startTime: '',
    capacity: '', minAge: '', maxAge: '', isKids: false, timed: true, gpxUploadId: null, price: '', prices: {},
    hidden: false, taken: 0, inUse: false, saved: null, ...over,
  }
}

// '' → null, '12' → 12, anything else → NaN (the validator refuses it).
function int(v) {
  const t = String(v ?? '').trim()
  if (!t) return null
  return /^\d+$/.test(t) ? Number(t) : Number.NaN
}

// The item without pricing or visibility, which depend on the section.
function baseItem(r) {
  return {
    ...(r.categoryId ? { categoryId: r.categoryId } : {}),
    name: r.name,
    kind: r.kind,
    ...(r.kind === 'team' ? { teamMin: int(r.teamMin), teamMax: int(r.teamMax) } : {}),
    discipline: r.discipline,
    distanceLabel: r.distanceLabel.trim() || null,
    startTime: r.startTime || null,
    capacity: int(r.capacity),
    minAge: int(r.minAge),
    maxAge: int(r.maxAge),
    isKids: r.isKids,
    timed: r.timed,
    gpxUploadId: r.gpxUploadId,
    price: r.price,
    prices: { ...(r.prices ?? {}) },
  }
}

/** The section's name for a tier column: its id, or `new:<index>` for one the save creates. */
const tierRef = (t, i) => t.id ?? `new:${i}`

function sectionItem(base, row, { pricingMode, state, tiers = [] }) {
  const { price, prices, ...item } = base
  if (pricingMode === 'fixed') item.price = price
  if (pricingMode === 'tiered') item.prices = Object.fromEntries(tiers.map((t, i) => [tierRef(t, i), prices?.[t.key] ?? '']))
  if (state !== 'draft') item.hidden = row.hidden
  return item
}

// ---------------------------------------------------------------- tiers

const newTier = (endsOn = '') => ({ key: `local:${++tierSeq}`, id: null, endsOn })

/**
 * The columns of the tier grid from the event (live or staged, registration_raw's order):
 * [{ key, id, endsOn }], the last one open-ended (endsOn null). A dated column not yet filled
 * in has endsOn ''. No tiers (fixed or free so far) → one dated column and the close.
 */
export function tierColumns(tiers, pricingMode) {
  if (pricingMode !== 'tiered' || !tiers?.length) return [newTier(), newTier(null)]
  return tiers.map((t, i) => ({ key: tierRef(t, i), id: t.id ?? null, endsOn: t.endsOn ?? null }))
}

/** „+ Próg”: a dated column before the open-ended one. */
export function addTier(tiers) {
  if (tiers.length >= MAX_TIERS) return tiers
  const last = tiers.length - 1
  return [...tiers.slice(0, last), newTier(), ...tiers.slice(last)]
}

export const canAddTier = (tiers) => tiers.length < MAX_TIERS

/** The column in force today: the first not yet ended (Warsaw days), or the open-ended one. */
export function currentTierIndex(tiers, today = warsawToday()) {
  return tiers.findIndex((t) => t.endsOn === null || (t.endsOn && t.endsOn >= today))
}

/**
 * A8, ruling 9: once any competition is in use, the saved columns in force or past keep their
 * date and stay (`date`); a competition in use keeps its amounts in them (`amountOf(row)`).
 * Columns the event does not have yet are never locked. The current column is judged among the
 * saved ones only, as registration_check_locks does.
 */
export function tierLocks(tiers, rows, { published, today = warsawToday() }) {
  const saved = tiers.filter((t) => t.id)
  const cur = saved[currentTierIndex(saved, today)]
  const anyInUse = published && rows.some((r) => r.inUse)
  const fixedTier = (t) => !!t.id && (t === cur || (t.endsOn !== null && t.endsOn < today))
  return {
    date: (t) => anyInUse && fixedTier(t),
    amount: (t, row) => published && row.inUse && fixedTier(t),
    // A new column must end after the current one: none can when the open-ended one is current.
    canAdd: canAddTier(tiers) && !(anyInUse && cur && cur.endsOn === null),
  }
}

/** „DO 15.11” for a column header, „DO” while its date is blank. */
export function tierLabel(endsOn) {
  if (!endsOn) return 'DO'
  const [, m, d] = endsOn.split('-')
  return `DO ${Number(d)}.${m}`
}

/** 1.12 for the last open day. */
export function dayLabel(iso) {
  if (!iso) return ''
  const [, m, d] = iso.split('-')
  return `${Number(d)}.${m}`
}

/** The save answered `tierIds` in column order: give them to the columns sent without one. */
export function assignTierIds(tiers, sentKeys, ids) {
  return tiers.map((t) => {
    const i = sentKeys.indexOf(t.key)
    return i < 0 || t.id || !ids?.[i] ? t : { ...t, id: ids[i] }
  })
}

/**
 * The fee box switched from `from` → { rows, tiers }. To tiered: columns as kept (or one dated and the close),
 * and an empty cell takes the row's fixed price. Leaving tiered: the fixed price is today's tier
 * price, the tier the server keeps (Task 3 ruling), and the columns lose their ids, because the
 * save that follows deletes every other tier: coming back, every column goes out as new (I-1).
 */
export function switchPricing(rows, tiers, mode, today = warsawToday(), from = 'tiered') {
  if (mode === 'tiered') {
    return {
      tiers,
      rows: rows.map((r) => ({
        ...r, prices: Object.fromEntries(tiers.map((t) => [t.key, r.prices?.[t.key] || r.price || ''])),
      })),
    }
  }
  const cur = tiers[currentTierIndex(tiers, today)] ?? tiers[tiers.length - 1]
  return {
    tiers: tiers.map((t) => ({ ...t, id: null })),
    rows: mode === 'fixed' && from === 'tiered' && cur
      ? rows.map((r) => ({ ...r, price: r.prices?.[cur.key] || r.price }))
      : rows,
  }
}

function tierListError(tiers, ctx) {
  if (tiers.some((t, i) => i < tiers.length - 1 && !t.endsOn)) return 'Podaj datę końca każdego progu.'
  const check = validateSection('competitions', {
    pricingMode: 'tiered', items: [], tiers: tiers.map((t) => ({ ...(t.id ? { id: t.id } : {}), endsOn: t.endsOn })),
  }, ctx)
  return check.ok ? null : check.errors.tiers ?? null
}

const started = (r) => !!(r.categoryId || r.name.trim() || r.capacity.trim() || r.distanceLabel.trim() || r.startTime)

/**
 * → { ok, value: { pricingMode, items, tiers? }, sentKeys, sentTierKeys, rowErrors: { [rowKey]: { field: message } },
 *     tierError, rows }
 * `rows` carry their new last whole value; `sentKeys[i]` is the row behind items[i], `sentTierKeys[i]`
 * the column behind tiers[i]. `opensAt` / `closesAt` (the window, timestamps) judge the tier dates.
 */
export function competitionsSection(rows, { pricingMode, state, tiers = [], opensAt = null, closesAt = null }) {
  const tiered = pricingMode === 'tiered'
  const ctx = { pricingMode, state, tiers }
  const tierList = tiered ? tiers.map((t) => ({ ...(t.id ? { id: t.id } : {}), endsOn: t.endsOn || null })) : undefined
  const items = []
  const sentKeys = []
  const rowErrors = {}
  const settled = rows.map((r) => {
    const base = baseItem(r)
    const item = sectionItem(base, r, ctx)
    // A row is judged on its own fields: the tier dates are the grid's, reported once below it.
    const check = validateSection('competitions', { pricingMode, items: [item], ...(tiered ? { tiers: tierList } : {}) }, { state })
    const errors = Object.fromEntries(Object.entries(check.ok ? {} : check.errors).filter(([k]) => k !== 'tiers'))
    if (!Object.keys(errors).length) {
      items.push(item)
      sentKeys.push(r.key)
      return { ...r, saved: base }
    }
    if (started(r)) rowErrors[r.key] = errors
    if (r.saved) {
      items.push(sectionItem(r.saved, r, ctx))
      sentKeys.push(r.key)
    }
    return r
  })
  const value = { pricingMode, items, ...(tiered ? { tiers: tierList } : {}) }
  const tierError = tiered ? tierListError(tiers, { state, opensAt, closesAt }) : null
  const ok = !tierError && validateSection('competitions', value, { state, opensAt, closesAt }).ok
  return { ok, value, sentKeys, sentTierKeys: tiered ? tiers.map((t) => t.key) : [], rowErrors, tierError, rows: settled }
}

/** The save answered `categoryIds` in item order: give them to the rows sent without one. */
export function assignIds(rows, sentKeys, ids) {
  return rows.map((r) => {
    const i = sentKeys.indexOf(r.key)
    if (i < 0 || r.categoryId || !ids?.[i]) return r
    const categoryId = ids[i]
    return { ...r, categoryId, saved: r.saved ? { ...r.saved, categoryId } : r.saved }
  })
}

/** Sum of the visible competitions' limits: a team competition's limit counts teams. */
export function eventCapacity(rows) {
  const sum = { people: 0, teams: 0 }
  for (const r of rows) {
    const n = int(r.capacity)
    if (!r.hidden && Number.isInteger(n)) sum[r.kind === 'team' ? 'teams' : 'people'] += n
  }
  return sum
}

/** The word beside a team competition's limit. A number still being typed reads as many. */
export function capacityUnit(capacity) {
  const n = int(capacity)
  return pluralPl(Number.isInteger(n) && n >= 0 ? n : 0, 'DRUŻYNA', 'DRUŻYNY', 'DRUŻYN')
}

/** „200 OSÓB + 20 DRUŻYN”. */
export function capacityLabel(rows) {
  const { people, teams } = eventCapacity(rows)
  const labels = []
  if (people || !teams) labels.push(countPl(people, ['OSOBA', 'OSOBY', 'OSÓB']))
  if (teams) labels.push(countPl(teams, ['DRUŻYNA', 'DRUŻYNY', 'DRUŻYN']))
  return labels.join(' + ')
}
