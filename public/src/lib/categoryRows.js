// The Kategorie step as pure functions. Age classes are one template (K and
// M brackets) applied to every visible adult competition; kids' birth-year
// groups belong to one kids competition each. The generators are the
// server's own (ageGroups.js), imported by relative path for node --test.
import { generateAgeGroups, generateKidsGroups } from '../../../supabase/functions/_shared/registration/ageGroups.js'

const byGenderThenAge = (a, b) => a.gender.localeCompare(b.gender) || a.minAge - b.minAge

/** The brackets as one competition holds them: unique by gender and label, K first, youngest first. */
export function ageTemplateFrom(groups) {
  const seen = new Map()
  for (const g of groups ?? []) {
    const k = `${g.gender}|${g.label}`
    if (!seen.has(k)) seen.set(k, { gender: g.gender, label: g.label, minAge: g.minAge, maxAge: g.maxAge ?? null })
  }
  return [...seen.values()].sort(byGenderThenAge)
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** { mode: 'step10'|'step5'|'custom', from, to } read back from a template; null when there is none. */
export function ageModeOf(template) {
  if (!template?.length) return null
  const from = Math.min(...template.map((g) => g.minAge))
  const open = template.find((g) => g.maxAge == null)
  const to = open ? open.minAge : Math.max(...template.map((g) => g.maxAge))
  for (const mode of ['step10', 'step5']) {
    if (open && same(generateAgeGroups({ mode, from, to }).sort(byGenderThenAge), template)) return { mode, from, to }
  }
  return { mode: 'custom', from, to }
}

export function ageTemplate(mode, from, to) {
  return generateAgeGroups({ mode, from, to }).sort(byGenderThenAge)
}

/**
 * The ageGroups list for the categories section. `idOf`: Map
 * `${categoryId}|${gender}|${label}` → stored id, so saved groups keep theirs.
 */
export function ageGroupsValue(template, competitions, idOf = new Map()) {
  const out = []
  for (const c of competitions) {
    if (!c.categoryId || c.isKids || c.hidden) continue
    for (const t of template) {
      const id = idOf.get(`${c.categoryId}|${t.gender}|${t.label}`)
      out.push({ ...(id ? { id } : {}), categoryId: c.categoryId, gender: t.gender, label: t.label, minAge: t.minAge, maxAge: t.maxAge })
    }
  }
  return out
}

let rowSeq = 0
/** A kids group row. One loaded with an id starts with `saved`, its last whole value. */
export const kidsRow = (g = {}) => {
  const row = {
    key: ++rowSeq, id: g.id ?? null, label: g.label ?? '', birthYearFrom: g.birthYearFrom ?? null,
    birthYearTo: g.birthYearTo ?? null, gender: g.gender ?? null, distanceLabel: g.distanceLabel ?? '', saved: null,
  }
  if (row.id) row.saved = wholeKids(row)
  return row
}

/** Default groups for a kids competition: its age range turned into birth years of the race year. */
export function kidsRowsFor(competition, eventDate, mode) {
  const year = Number(String(eventDate ?? '').slice(0, 4)) || new Date().getFullYear()
  const fromYear = year - (competition.maxAge ?? 15)
  const toYear = year - (competition.minAge ?? 0)
  return generateKidsGroups({ mode, fromYear, toYear })
    .map((g) => kidsRow({ label: g.label, birthYearFrom: g.minYear, birthYearTo: g.maxYear }))
}

/** 'step2' / 'step1' when every row has that width (the last may be shorter), else 'custom'. */
export function kidsModeOf(rows) {
  if (!rows?.length) return null
  const sorted = [...rows].sort((a, b) => a.birthYearFrom - b.birthYearFrom)
  for (const [mode, width] of [['step1', 1], ['step2', 2]]) {
    const fits = sorted.every((r, i) => {
      const w = r.birthYearTo - r.birthYearFrom + 1
      const contiguous = i === 0 || r.birthYearFrom === sorted[i - 1].birthYearTo + 1
      return contiguous && (w === width || (i === sorted.length - 1 && w < width))
    })
    if (fits) return mode
  }
  return 'custom'
}

const yearOk = (y) => Number.isInteger(y) && y >= 1900 && y <= 2200

// The row's item without categoryId, or null while it is not whole.
function wholeKids(r) {
  if (!r.label.trim() || !yearOk(r.birthYearFrom) || !yearOk(r.birthYearTo) || r.birthYearTo < r.birthYearFrom) return null
  return {
    label: r.label.trim(), birthYearFrom: r.birthYearFrom, birthYearTo: r.birthYearTo,
    gender: r.gender ?? null, distanceLabel: r.distanceLabel.trim() || null,
  }
}

/** Whole rows remember their value, for when they are next edited half-way. */
export const settleKids = (rows) => rows.map((r) => {
  const whole = wholeKids(r)
  return whole ? { ...r, saved: whole } : r
})

/**
 * → { items, sentKeys }: whole rows; a saved row being retyped goes with its
 * last whole value, so a half-typed edit never deletes it.
 */
export function kidsGroupsValue(categoryId, rows) {
  const items = []
  const sentKeys = []
  for (const r of rows) {
    const whole = wholeKids(r) ?? (r.id ? r.saved : null)
    if (!whole) continue
    items.push({ ...(r.id ? { id: r.id } : {}), categoryId, ...whole })
    sentKeys.push(r.key)
  }
  return { items, sentKeys }
}

/**
 * The whole categories section, without side effects (I2): the caller records
 * ageKeys / kidsKeys only when a save starts. Visible adult competitions get
 * the template; a hidden competition keeps its stored groups unchanged (I4),
 * because the list replaces every group of the event.
 * → { value: { ageReckoning, ageGroups, kidsGroups }, ageKeys, kidsKeys }
 */
export function categoriesSection({ reckoning, template, competitions, kids, stored = {}, idOf = new Map() }) {
  const ageGroups = []
  const kidsGroups = []
  const kidsKeys = []
  for (const c of competitions) {
    if (!c.categoryId) continue
    if (c.hidden) {
      const own = (list) => (list ?? []).filter((g) => g.categoryId === c.categoryId)
      if (!c.isKids) {
        ageGroups.push(...own(stored.ageGroups).map((g) => ({
          ...(g.id ? { id: g.id } : {}), categoryId: c.categoryId, gender: g.gender, label: g.label, minAge: g.minAge, maxAge: g.maxAge ?? null,
        })))
      } else {
        for (const g of own(stored.kidsGroups)) {
          kidsGroups.push({
            ...(g.id ? { id: g.id } : {}), categoryId: c.categoryId, label: g.label, birthYearFrom: g.birthYearFrom,
            birthYearTo: g.birthYearTo, gender: g.gender ?? null, distanceLabel: g.distanceLabel ?? null,
          })
          kidsKeys.push(null)
        }
      }
      continue
    }
    if (!c.isKids) ageGroups.push(...ageGroupsValue(template, [c], idOf))
    else {
      const { items, sentKeys } = kidsGroupsValue(c.categoryId, kids[c.categoryId] ?? [])
      kidsGroups.push(...items)
      kidsKeys.push(...sentKeys)
    }
  }
  const ageKeys = ageGroups.map((g) => `${g.categoryId}|${g.gender}|${g.label}`)
  return { value: { ageReckoning: reckoning, ageGroups, kidsGroups }, ageKeys, kidsKeys }
}

/** The age group ids, from the latest answer only (I1): a group it left out was deleted. */
export function ageIdsFrom(ageKeys, ids) {
  return new Map(ageKeys.map((k, i) => [k, ids?.[i]]).filter(([k, id]) => k && id))
}

/**
 * Row ids after a save (I1). A draft save answers the ids of the rows it was
 * sent, in order; any other row was deleted (or never stored) and has none.
 * A staged save (published event) answers no ids: rows stay as they are.
 */
export function reconcileRowIds(rows, sentKeys, ids) {
  if (!Array.isArray(ids)) return rows
  return rows.map((r) => {
    const i = sentKeys.indexOf(r.key)
    const id = i >= 0 ? ids[i] ?? null : null
    if (id === r.id) return r
    return { ...r, id, saved: id ? r.saved : null }
  })
}

/** „4 KONKURENCJE”, „12 KONKURENCJI”: forms = [one, few (2–4), many]. */
export function countLabel(n, [one, few, many]) {
  const form = n === 1 ? one
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many
  return `${n} ${form}`
}
