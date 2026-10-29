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
export const kidsRow = (g = {}) => ({
  key: ++rowSeq, id: g.id ?? null, label: g.label ?? '', birthYearFrom: g.birthYearFrom ?? null,
  birthYearTo: g.birthYearTo ?? null, gender: g.gender ?? null, distanceLabel: g.distanceLabel ?? '',
})

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

/** → { items, sentKeys }: whole rows only (a label and both years in order). */
export function kidsGroupsValue(categoryId, rows) {
  const items = []
  const sentKeys = []
  for (const r of rows) {
    if (!r.label.trim() || !yearOk(r.birthYearFrom) || !yearOk(r.birthYearTo) || r.birthYearTo < r.birthYearFrom) continue
    items.push({
      ...(r.id ? { id: r.id } : {}), categoryId, label: r.label.trim(), birthYearFrom: r.birthYearFrom,
      birthYearTo: r.birthYearTo, gender: r.gender ?? null, distanceLabel: r.distanceLabel.trim() || null,
    })
    sentKeys.push(r.key)
  }
  return { items, sentKeys }
}

/** „4 KONKURENCJE”, „12 KONKURENCJI”: forms = [one, few (2–4), many]. */
export function countLabel(n, [one, few, many]) {
  const form = n === 1 ? one
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many
  return `${n} ${form}`
}
