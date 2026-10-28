// Age classes (K/M) and kids' birth-year groups. Plain ESM: runs in Deno and Node.

const EN_DASH = '–'

function parts(isoDate) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number)
  return { y, m, d }
}

/**
 * Age in whole years. 'race_day': birthday reached on raceDate (a leap-day birthday counts from 1 March in
 * non-leap years). 'year_end': age reached by 31 December of the race year.
 */
export function ageOn(birthDate, raceDate, reckoning = 'race_day') {
  const b = parts(birthDate)
  const r = parts(raceDate)
  if (reckoning === 'year_end') return r.y - b.y
  let age = r.y - b.y
  if (r.m < b.m || (r.m === b.m && r.d < b.d)) age -= 1
  return age
}

/** K and M groups: [{ gender, label, minAge, maxAge|null }]. The last group is open-ended at `to`. */
export function generateAgeGroups({ mode, from, to }) {
  const step = mode === 'step5' ? 5 : 10
  const starts = [from]
  for (let b = Math.ceil((from + step) / step) * step; b < to; b += step) starts.push(b)
  starts.push(to)
  const out = []
  for (const gender of ['K', 'M']) {
    for (let i = 0; i < starts.length; i++) {
      const minAge = starts[i]
      const last = i === starts.length - 1
      const maxAge = last ? null : starts[i + 1] - 1
      out.push({ gender, label: `${gender}${minAge}${last ? '+' : `${EN_DASH}${maxAge}`}`, minAge, maxAge })
    }
  }
  return out
}

/** The runner's class label, or `K open` / `M open` when no group covers them. */
export function ageGroupLabel({ birthDate, gender, raceDate, reckoning = 'race_day', groups = [] }) {
  const age = ageOn(birthDate, raceDate, reckoning)
  const hit = groups.find((g) => g.gender === gender && age >= g.minAge && (g.maxAge == null || age <= g.maxAge))
  return hit ? hit.label : `${gender} open`
}

/** Kids' groups by birth year: [{ label, minYear, maxYear }], 'step2' pairs years, 'step1' one group per year. */
export function generateKidsGroups({ mode, fromYear, toYear }) {
  const width = mode === 'step1' ? 1 : 2
  const out = []
  for (let y = fromYear; y <= toYear; y += width) {
    const maxYear = Math.min(y + width - 1, toYear)
    out.push({ label: maxYear === y ? `${y}` : `${y}${EN_DASH}${maxYear}`, minYear: y, maxYear })
  }
  return out
}

/** The kids' group whose birth years include the runner's, or null. */
export function kidsGroupFor(birthDate, kidsGroups = []) {
  const { y } = parts(birthDate)
  return kidsGroups.find((g) => y >= g.minYear && y <= g.maxYear) ?? null
}
