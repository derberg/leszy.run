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
import { validateSection } from '../../../supabase/functions/_shared/registration/sections.js'

let rowSeq = 0

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
    hidden: !!c.hiddenAt,
    taken: c.taken ?? 0,
    saved: null,
  }
  row.saved = baseItem(row)
  return row
}

export function newCompetitionRow(over = {}) {
  return {
    key: ++rowSeq, categoryId: null, name: '', discipline: 'run', distanceLabel: '', startTime: '',
    capacity: '', minAge: '', maxAge: '', isKids: false, timed: true, gpxUploadId: null, price: '',
    hidden: false, taken: 0, saved: null, ...over,
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
    kind: 'individual',
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
  }
}

function sectionItem(base, row, { pricingMode, state }) {
  const { price, ...item } = base
  if (pricingMode === 'fixed') item.price = price
  if (state !== 'draft') item.hidden = row.hidden
  return item
}

const started = (r) => !!(r.categoryId || r.name.trim() || r.capacity.trim() || r.distanceLabel.trim() || r.startTime)

/**
 * → { ok, value: { pricingMode, items }, sentKeys, rowErrors: { [rowKey]: { field: message } }, rows }
 * `rows` carry their new last whole value; `sentKeys[i]` is the row behind items[i].
 */
export function competitionsSection(rows, { pricingMode, state }) {
  const ctx = { pricingMode, state }
  const items = []
  const sentKeys = []
  const rowErrors = {}
  const settled = rows.map((r) => {
    const base = baseItem(r)
    const item = sectionItem(base, r, ctx)
    const check = validateSection('competitions', { pricingMode, items: [item] }, { state })
    if (check.ok) {
      items.push(item)
      sentKeys.push(r.key)
      return { ...r, saved: base }
    }
    if (started(r)) rowErrors[r.key] = check.errors
    if (r.saved) {
      items.push(sectionItem(r.saved, r, ctx))
      sentKeys.push(r.key)
    }
    return r
  })
  const value = { pricingMode, items }
  const ok = validateSection('competitions', value, { state }).ok
  return { ok, value, sentKeys, rowErrors, rows: settled }
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

/** Sum of the visible competitions' limits. */
export function eventCapacity(rows) {
  return rows.filter((r) => !r.hidden).reduce((sum, r) => sum + (Number.isInteger(int(r.capacity)) ? int(r.capacity) : 0), 0)
}
