// Merge safety for distances mined out of a regulamin (run-enrich-from-regulamin.js).
//
// The regulamin is authoritative about the race it describes, so its distances
// normally replace whatever the scraper read off the listing. The exception is a
// document that only SUBTRACTS: that is the signature of a stale edition, not a
// correction.
//
// zapisyonline hosts one regulamin per edition of a recurring series, and an older
// upload predates races the organizer has since added. Kosakowo Biega 2026-10-03
// was scraped as "2 km, 5 km, 500 m"; an edition-741 regulamin listing only
// "Dystans biegu: 5 km" cut the public calendar entry down to "5 km" and lost both
// kids races. The same race's OWN regulamin describes only the 5 km as well. The
// organizer keeps the kids distances on the registration page and out of the rules.

// Split a distances string into a comparable set of tokens ("2 km, 5 km, 500 m").
function distanceSet(str) {
  if (!str) return new Set()
  return new Set(str.split(',').map(d => d.trim().toLowerCase()).filter(Boolean))
}

// True when the regulamin's set removes distances the scraper found and adds none.
// A regulamin that adds or changes anything is treated as a real update and wins.
function dropsDistances(scraperStr, regulaminStr) {
  const before = distanceSet(scraperStr)
  const after = distanceSet(regulaminStr)
  if (before.size === 0 || after.size === 0) return false
  for (const d of after) if (!before.has(d)) return false
  return after.size < before.size
}

export { distanceSet, dropsDistances }
