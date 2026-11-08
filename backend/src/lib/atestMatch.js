// Matches calendar races to the PZLA register of certified courses
// (atestRegister.js) and to what the race's own regulamin says.
//
// Two sources, neither enough on its own:
//   - the register is authoritative about a COURSE but knows no edition, no
//     date and no URL, and its names are the organizer's in capitals, often
//     without the sponsor or edition number;
//   - the regulamin ("trasa posiada atest PZLA") speaks about THIS edition but
//     is the organizer's own claim.
//
// So an atest is published only where the register backs it:
//   - "both":     the regulamin claims it and a valid register row matches on
//                 town, distance and at least half the name;
//   - "register": no claim in the regulamin, but a valid register row matches
//                 on town and distance and either
//                   - at least half the name, with a shared word that is not
//                     generic, or
//                   - the whole name, generic words only ("BIEG NIEPODLEGŁOŚCI"),
//                     when that row is the only candidate of its distance in a
//                     town the register lists fewer than BIG_TOWN_ROWS courses
//                     for: a small town runs one 11 November race, Warsaw several.
// Everything weaker goes to the review list, never to the page. A regulamin
// that says the course has NO atest wins over the register: it describes this
// edition, and the register may still list a course the race has left.
//
// Thresholds measured on 2026-11-03 against the 496 future active
// calendar_events: at a 0.5 name score 55 races matched with many wrong pairs
// (Bieg Mikołajkowy Poznań ↔ POZNAŃ FIVE); at 1.0, with the town dropped from
// both names and a non-generic shared word required, about 30 matched.
// The first run (2026-11-08) left real matches in review: one-race towns
// (Ryki, Uniejów, Trzebnica: "Bieg Niepodległości" ↔ BIEG NIEPODLEGŁOŚCI),
// half-name matches on a real word (Szamotuły's PIĄTKA CIĘŻKIEGO, a register
// typo "BIEG IEPODLEGŁOŚCI RUNPOLAND"), and a children's row of a marathon
// festival got the marathon's atest. The town's adjective ("Opolski",
// "Żorski") now counts as the town, so it cannot be the shared word.

import { isValidCertificate } from './atestRegister.js'

// ±50 m. "21.1 km" is 21.0975 in the register, "42.2 km" is 42.195.
export const DISTANCE_TOLERANCE_KM = 0.05
export const STRICT_SCORE = 1
export const LOOSE_SCORE = 0.5
// Register rows per town from which a town is a city with several races of one
// generic name. Measured 2026-11-08: Poznań 66, Warszawa 52, Kraków 25,
// Bydgoszcz and Toruń 20; Koszalin 13 and Gdynia 11 hold one Bieg Sylwestrowy /
// Bieg Niepodległości each.
export const BIG_TOWN_ROWS = 20

const fold = (s) => String(s || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '')

// Words that say nothing about which race it is.
const STOP = new Set([
  'bieg', 'biegi', 'biegu', 'biegow', 'run', 'running', 'the', 'and', 'dla', 'pod', 'przy', 'oraz',
  'puchar', 'edycja', 'zawody', 'impreza', 'km', 'ulica', 'ulicami', 'imienia',
])

// Shared by many unrelated races in different towns, so a match on one of these
// alone proves nothing ("Gdyński Bieg Niepodległości" ↔ "BIEG NIEPODLEGŁOŚCI").
// Compared as stems (first 6 letters).
const GENERIC = new Set([
  'niepodleglosci', 'sylwestrowy', 'mikolajkowy', 'polmaraton', 'maraton', 'dycha', 'dziesiatka',
  'piatka', 'nocny', 'uliczny', 'charytatywny', 'walentynkowy', 'wiosenny', 'jesienny', 'zimowy',
  'letni', 'swiateczny', 'rodzinny', 'miejski', 'memorial', 'grand', 'prix', 'city', 'mila',
  'godzinny', 'konstytucji', 'trzeciego', 'maja', 'night', 'trail', 'festiwal', 'mistrzostwa',
  'polski', 'wojewodztwa', 'otwarty', 'otwarte', 'ulicznego', 'pamieci', 'bitwy', 'swieta',
  'rocznicy', 'wolnosci', 'olimpijski', 'family', 'kids', 'cross', 'nocna', 'niedziela',
].map((w) => w.slice(0, 6)))

const stem = (w) => w.slice(0, 6)

/**
 * Tests whether a word names the town, its adjective included: "Opolski" for
 * Opole, "Żorski" for Żory, "Pabianicki" for Pabianice. The town word loses its
 * final vowels and an adjective must start with what is left.
 */
function townMatcher(town) {
  const words = fold(town).split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
  const stems = new Set(words.map(stem))
  const roots = words.map((w) => w.replace(/[aeiouy]+$/, '')).filter((r) => r.length >= 3)
  return (w) => stems.has(stem(w)) || roots.some((r) => w.startsWith(r) && w.length - r.length <= 5)
}

/** The words of a race name that can tell it apart, as stems, minus the town's. */
export function nameTokens(name, town) {
  const isTown = townMatcher(town)
  const out = new Set()
  for (const w of fold(name).split(/[^a-z0-9]+/)) {
    if (w.length < 3) continue
    if (/^\d+$/.test(w)) continue
    if (/^[ivxlcdm]+$/.test(w)) continue
    if (STOP.has(w)) continue
    if (isTown(w)) continue
    out.add(stem(w))
  }
  return out
}

/**
 * Shared words over the word count of the shorter name, and whether a shared
 * word is not generic. Both names lose the town first: "Festiwal Biegów
 * Mikołajów – Toruń" matched RUN TORUŃ on the town alone.
 */
export function nameScore(eventName, registerName, town) {
  const a = nameTokens(eventName, town)
  const b = nameTokens(registerName, town)
  if (a.size === 0 || b.size === 0) return { score: 0, distinctive: false, realWord: false }
  const shared = [...a].filter((t) => b.has(t))
  // Both names carrying the town ("Pabianicki Półmaraton" ↔ "PABIANICKI
  // PÓŁMARATON") makes a generic word specific: it is that town's half marathon.
  // One name without it ("BIEG NIEPODLEGŁOŚCI") proves nothing.
  // That is enough only for the whole name: "Wrocławska Dycha Cztery Pory Roku"
  // shares half of WROCŁAWSKA DYCHA NIEPODLEGŁA and is another race.
  const bothNameTown = namesTown(eventName, town) && namesTown(registerName, town)
  const realWord = shared.some((t) => !GENERIC.has(t))
  return {
    score: shared.length / Math.min(a.size, b.size),
    distinctive: shared.length > 0 && (bothNameTown || realWord),
    realWord,
  }
}

function namesTown(name, town) {
  const isTown = townMatcher(town)
  return fold(name).split(/[^a-z0-9]+/).some((w) => w.length >= 3 && isTown(w))
}

/**
 * A row for children, or a nordic walking row with no run in it. A festival
 * often lists every distance on each of its rows, so the children's races
 * would carry the marathon's atest ("Biegi Jagienki dla dzieci i młodzieży").
 */
export function notARunRow(name) {
  const n = fold(name)
  if (/dzieci|dziecie|mlodziez|maluch|przedszkol|\bkids?\b/.test(n)) return true
  return /nordic|\bmarsz/.test(n) && !/\bbieg|maraton|\brun/.test(n)
}

/** "21.1 km" → 21.1, "Półmaraton" → 21.0975, "500 m" → 0.5. Null for "6h" and the like. */
export function distanceKm(d) {
  if (typeof d === 'number') return Number.isFinite(d) && d > 0 ? d : null
  if (!d || typeof d !== 'string') return null
  const s = fold(d).trim()
  if (/\d\s*h(\b|$)/.test(s)) return null
  if (/polmaraton|half/.test(s)) return 21.0975
  if (/maraton|marathon/.test(s)) return 42.195
  const m = s.match(/\d+(?:[.,]\d+)?/)
  if (!m) return null
  const n = parseFloat(m[0].replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  if (/\d\s*m\b|metr/.test(s) && !/km|kilometr/.test(s)) return n / 1000
  // "21 km" and "42 km" are how many listings write the half and the full
  // marathon; taken literally they miss 21.0975 by more than the tolerance.
  if (n === 21) return 21.0975
  if (n === 42) return 42.195
  return n
}

export function sameDistance(a, b) {
  return a != null && b != null && Math.abs(a - b) <= DISTANCE_TOLERANCE_KM
}

/** The town part of a calendar location ("Warszawa, ul. Mokotowska 1" → "warszawa"). */
export function townOf(location) {
  if (!location) return ''
  const loc = typeof location === 'object' ? (location.city || '') : String(location)
  return fold(loc.replace(/\s*(ul\.|al\.|os\.|pl\.)\s.*/i, '').split(/[,–(]/)[0]).trim()
}

/** True when the register's town is the race's town ("Lisowice k. Lublińca" counts as Lisowice). */
export function sameTown(eventLocation, registerTown) {
  const a = townOf(eventLocation)
  const b = fold(registerTown).trim()
  if (!a || !b) return false
  return a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `)
}

/** scraper_all.distances is a comma string, calendar_events.distances an array. */
export function eventDistances(distances) {
  const list = Array.isArray(distances)
    ? distances
    : String(distances || '').split(',').map((d) => d.trim()).filter(Boolean)
  return list.map(distanceKm).filter((km) => km != null)
}

/** Does the regulamin claim an atest for this distance? A claim naming no distance covers every one. */
function claimCovers(claim, km) {
  if (!claim || claim.certified !== true) return false
  const listed = Array.isArray(claim.distances_km) ? claim.distances_km.map(distanceKm).filter((x) => x != null) : []
  if (listed.length === 0) return true
  return listed.some((l) => Math.abs(l - km) <= 0.15)
}

/**
 * Decides the atest of one race.
 * @param {{ name: string, location: any, date: string, distances: any, atest_claim?: { certified: boolean|null, distances_km?: number[] }|null }} event
 * @param {{ distance_km: number, town: string, name: string, certified_on: string|null, status: string|null }[]} register
 * @returns {{ atest: { km: number, certified_on: string, source: 'both'|'register' }[], review: object[] }}
 */
export function matchEvent(event, register) {
  const atest = []
  const review = []
  const claim = event.atest_claim || null
  const onDate = String(event.date || '').slice(0, 10)
  const kms = [...new Set(eventDistances(event.distances))]
  if (notARunRow(event.name)) return { atest, review }

  const candidates = register.filter((r) => sameTown(event.location, r.town))
  const smallTown = candidates.length < BIG_TOWN_ROWS
  for (const km of kms) {
    const scored = candidates
      .filter((r) => sameDistance(km, r.distance_km))
      .map((r) => ({ row: r, valid: isValidCertificate(r, onDate), ...nameScore(event.name, r.name, r.town) }))
      .sort((x, y) => y.score - x.score || Number(y.valid) - Number(x.valid))
    const claimed = claimCovers(claim, km)
    const looseValid = scored.filter((s) => s.valid && s.score >= LOOSE_SCORE)
    const strict = scored.find((s) => s.valid && ((s.score >= STRICT_SCORE && s.distinctive) || (s.score >= LOOSE_SCORE && s.realWord)))
      || (smallTown && looseValid.length === 1 && looseValid[0].score >= STRICT_SCORE ? looseValid[0] : undefined)
    const loose = scored.find((s) => s.valid && s.score >= LOOSE_SCORE)
    const expired = scored.find((s) => !s.valid && s.score >= LOOSE_SCORE)
    const pair = (s) => ({ register_name: s.row.name, register_town: s.row.town, certified_on: s.row.certified_on, status: s.row.status, score: Number(s.score.toFixed(2)) })

    if (claim?.certified === false && (strict || loose)) {
      review.push({ reason: 'regulamin_denies', km, ...pair(strict || loose) })
      continue
    }
    if (claimed && loose) {
      atest.push({ km: loose.row.distance_km, certified_on: loose.row.certified_on, source: 'both' })
      continue
    }
    if (strict) {
      atest.push({ km: strict.row.distance_km, certified_on: strict.row.certified_on, source: 'register' })
      continue
    }
    if (claimed && expired) {
      review.push({ reason: 'claim_expired', km, ...pair(expired) })
      continue
    }
    if (claimed) {
      review.push({ reason: 'claim_unconfirmed', km })
      continue
    }
    if (loose) review.push({ reason: 'near_miss', km, ...pair(loose) })
  }
  if (claim?.certified === true && kms.length === 0) review.push({ reason: 'claim_unconfirmed', km: null })
  return { atest, review }
}

/** Order-independent equality of two stored atest arrays. */
export function sameAtest(a, b) {
  const key = (list) => JSON.stringify([...(list || [])].map((x) => [x.km, x.certified_on, x.source]).sort())
  return key(a) === key(b)
}
