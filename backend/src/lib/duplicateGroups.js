import { jaccardSimilarity, citiesMatch, citiesConflict } from '../scrapers/dedup.js'

/**
 * Should the admin "Duplikaty" tab offer these two same-date events as one?
 *
 * Tiered match. This is a manual-review tab — false positives are
 * dismissable, missed duplicates are not — so the same-city bar is
 * deliberately low (0.15). Real duplicates cluster at jaccard 0.25–0.33 (one
 * name is a short variant of the other, e.g. "Wataha 7 km" vs "Wataha 7 km
 * Nordic Walking"), so a single 0.35 cutoff silently hid every duplicate. The
 * 0.6 tier still matches without a city match, for a row with a missing or
 * misspelt town, but never across two plainly different towns: on 11 November
 * every town runs a "Bieg Niepodległości", and the name-only tier put about
 * fifty of them in one group. The merge got the same guard in #284.
 */
export function isDuplicatePair(a, b) {
  if (citiesConflict(a.location, b.location)) return false
  const sim = jaccardSimilarity(a.name, b.name)
  if (sim > 0.6) return true
  return citiesMatch(a.location, b.location) && sim > 0.15
}

/**
 * Groups same-date events into duplicate clusters of two or more.
 *
 * Two clusters join only when no member of one conflicts by town with a
 * member of the other. Without that, a row with no location bridged
 * "Bieg Niepodległości" in Radom to the one in Gdynia, since each pair on its
 * own passed.
 *
 * @param {Array<{id: string, name: string, date: string, location: ?string}>} events
 * @param {Set<string>} dismissed `${id1}:${id2}` keys, both orders
 */
export function groupDuplicates(events, dismissed = new Set()) {
  const byDate = {}
  for (const e of events) (byDate[e.date] ||= []).push(e)

  const parent = {}
  const members = {}
  for (const e of events) { parent[e.id] = e.id; members[e.id] = [e] }
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => {
    const ra = find(a), rb = find(b)
    if (ra === rb) return
    const clash = members[ra].some(x => members[rb].some(y => citiesConflict(x.location, y.location)))
    if (clash) return
    parent[ra] = rb
    members[rb] = members[rb].concat(members[ra])
    delete members[ra]
  }

  for (const sameDay of Object.values(byDate)) {
    for (let i = 0; i < sameDay.length; i++) {
      for (let j = i + 1; j < sameDay.length; j++) {
        const a = sameDay[i], b = sameDay[j]
        if (dismissed.has(`${a.id}:${b.id}`)) continue
        if (isDuplicatePair(a, b)) union(a.id, b.id)
      }
    }
  }

  return Object.values(members)
    .filter(g => g.length > 1)
    .sort((a, b) => a[0].date.localeCompare(b[0].date))
}
