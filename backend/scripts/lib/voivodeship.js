// A row that already carries coordinates knows where it is, and the geocode run
// used to throw that away.
//
// VI Bieg Szlakiem Bursztynowym "KARTOFELEK" (dostartu 17349, 2026-10-18) is in
// Ujazd and came from the dostartu API with lat 50.3888097 and lng 18.3476407.
// dostartu publishes no voivodeship at all, so the run had to derive one. Ujazd
// is not in the city map, so the run asked Nominatim for the NAME, and the name
// answers with settlements in six voivodeships. The ambiguity guard refused to
// guess, correctly, and the row published with an empty region column while its
// own coordinates pinned it to Opolskie without any choice to make.
//
// The city map still answers first: it is free and it is a decision already
// made. Only when the name is not in the map do the coordinates get asked.
export async function voivodeshipForLocatedRow({ city, lat, lng }, { fromCityMap, reverseGeocode }) {
  const mapped = fromCityMap(city)
  if (mapped) return { voivodeship: mapped, via: 'city map' }

  if (lat == null || lng == null) return { voivodeship: null, via: null }

  const { voivodeship } = await reverseGeocode(lat, lng)
  return voivodeship ? { voivodeship, via: 'coordinates' } : { voivodeship: null, via: null }
}
