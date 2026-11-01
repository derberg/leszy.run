// The Dodatki step's cards (A5b) as pure functions: a card per extra with text inputs, the extras
// section value the server takes, and the ids a save hands back. The rules are the server's own
// validateSection('extras'), imported by relative path so node --test can load this module too.
//
// * The section is the whole list. A card is sent once it is whole; a card the server already has
//   and someone is mid-way through editing sends its last whole value, so a half-typed edit never
//   deletes it (the competitions step does the same).
// * A variant with no limit is stored as MAX_STOCK (§4.8) and shown as an empty field.
// * No competition chosen means every competition: the chips show all of them on.
// * After publish (ruling 10) a variant that sold stays and keeps at least what sold, and an
//   extra with a sold variant keeps its price and stays.
import { MAX_STOCK, validateSection } from '../../../supabase/functions/_shared/registration/sections.js'
import { priceText } from './competitionRows.js'

let seq = 0

const STOCK_MESSAGE = `Limit sztuk: od 0 do ${MAX_STOCK.toLocaleString('pl-PL')}.`

function newVariant(over = {}) {
  return { key: `v${++seq}`, id: null, label: '', stock: '', sold: 0, ...over }
}

/** A card from get-registration-event's extra (or a staged one, through stagedEvent). */
export function extraRow(x) {
  const row = {
    key: `x${++seq}`,
    id: x.id ?? null,
    name: x.name ?? '',
    price: priceText(x.price),
    orderUntil: x.orderUntil ?? '',
    imageUploadId: x.imageUploadId ?? null,
    categoryIds: [...(x.categoryIds ?? [])],
    variants: (x.variants ?? []).map((v) => newVariant({
      id: v.id ?? null, label: v.label ?? '', stock: v.stock == null || v.stock >= MAX_STOCK ? '' : String(v.stock), sold: v.sold ?? 0,
    })),
    saved: null,
    savedKeys: [], // the variant keys behind saved.variants, in order
  }
  row.saved = itemOf(row)
  row.savedKeys = row.variants.map((v) => v.key)
  return row
}

export function newExtraRow() {
  return { key: `x${++seq}`, id: null, name: '', price: '', orderUntil: '', imageUploadId: null, categoryIds: [], variants: [newVariant()], saved: null, savedKeys: [] }
}

export const addVariant = (row) => ({ ...row, variants: [...row.variants, newVariant()] })

/** Ruling 10's locks, as the wizard shows them. */
export const extraSold = (row) => row.variants.some((v) => v.sold > 0)

// '' → MAX_STOCK (no limit), '12' → 12, anything else → NaN (the validator refuses it).
function stockOf(v) {
  const t = String(v ?? '').trim()
  if (!t) return MAX_STOCK
  return /^\d+$/.test(t) ? Number(t) : Number.NaN
}

function itemOf(r) {
  return {
    ...(r.id ? { id: r.id } : {}),
    name: r.name,
    imageUploadId: r.imageUploadId,
    price: r.price,
    orderUntil: r.orderUntil,
    categoryIds: [...r.categoryIds],
    variants: r.variants.map((v) => ({ ...(v.id ? { id: v.id } : {}), label: v.label, stock: stockOf(v.stock) })),
  }
}

const started = (r) => !!(r.id || r.name.trim() || r.price.trim() || r.orderUntil || r.imageUploadId
  || r.variants.some((v) => v.label.trim() || String(v.stock).trim()))

/** The variant fields that do not validate, by variant key: { [key]: { label?, stock? } }. */
function variantErrors(r) {
  const out = {}
  for (const v of r.variants) {
    const e = {}
    if (!v.label.trim()) e.label = 'Podaj nazwę wariantu.'
    const n = stockOf(v.stock)
    if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK) e.stock = STOCK_MESSAGE
    else if (n < v.sold) e.stock = `Sprzedano ${v.sold}: limit nie może być mniejszy.`
    if (Object.keys(e).length) out[v.key] = e
  }
  return out
}

/**
 * → { ok, value: { items }, sentKeys, sentVariantKeys, cardErrors: { [cardKey]: { fields, variants } }, rows }
 * `rows` carry their new last whole value; `sentKeys[i]` is the card behind items[i], and
 * `sentVariantKeys[i][k]` the variant behind items[i].variants[k]. `eventDate`
 * is the race day an order deadline may not pass.
 */
export function extrasSection(rows, { state, eventDate = null }) {
  const ctx = { state, eventDate }
  const items = []
  const sentKeys = []
  const sentVariantKeys = []
  const cardErrors = {}
  const settled = rows.map((r) => {
    const item = itemOf(r)
    const check = validateSection('extras', { items: [item] }, ctx)
    const variants = variantErrors(r)
    // Variant fields are reported on the variant itself, not once for the card.
    const fields = check.ok ? {} : Object.fromEntries(Object.entries(check.errors).filter(([k]) => k !== 'label' && k !== 'stock'))
    if (check.ok && !Object.keys(variants).length) {
      const keys = r.variants.map((v) => v.key)
      items.push(item)
      sentKeys.push(r.key)
      sentVariantKeys.push(keys)
      return { ...r, saved: item, savedKeys: keys }
    }
    if (started(r)) cardErrors[r.key] = { fields, variants }
    if (r.saved) {
      items.push(r.saved)
      sentKeys.push(r.key)
      sentVariantKeys.push(r.savedKeys)
    }
    return r
  })
  const value = { items }
  const ok = validateSection('extras', value, ctx).ok
  return { ok, value, sentKeys, sentVariantKeys, cardErrors, rows: settled }
}

/** The save answered `extraIds` and `variantIds` in item order: give them to the cards and variants sent without one. */
export function assignExtraIds(rows, sentKeys, sentVariantKeys, extraIds, variantIds) {
  if (!Array.isArray(extraIds)) return rows
  return rows.map((r) => {
    const i = sentKeys.indexOf(r.key)
    if (i < 0 || !extraIds[i]) return r
    const vids = variantIds?.[i] ?? []
    // A variant added since the save started has no id to take.
    const idOf = new Map((sentVariantKeys[i] ?? []).map((key, k) => [key, vids[k]]))
    const variants = r.variants.map((v) => (v.id || !idOf.get(v.key) ? v : { ...v, id: idOf.get(v.key) }))
    const saved = r.saved && {
      ...r.saved, id: r.saved.id ?? extraIds[i],
      variants: r.saved.variants.map((v, k) => (v.id || !idOf.get(r.savedKeys[k]) ? v : { ...v, id: idOf.get(r.savedKeys[k]) })),
    }
    return { ...r, id: r.id ?? extraIds[i], variants, saved }
  })
}

/**
 * „Dostępne w konkurencjach”: the chips show which competitions offer the extra. An empty list
 * means all; turning one off from „all” keeps the others, and turning the last one off is refused
 * (it would read as all again).
 */
export function toggleCompetition(categoryIds, allIds, id) {
  const on = categoryIds.length ? categoryIds : allIds
  const next = on.includes(id) ? on.filter((c) => c !== id) : [...on, id]
  if (!next.length) return categoryIds
  return allIds.every((c) => next.includes(c)) ? [] : allIds.filter((c) => next.includes(c))
}

export const competitionOn = (categoryIds, id) => !categoryIds.length || categoryIds.includes(id)
