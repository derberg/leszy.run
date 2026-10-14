// Default display order of the participants table: category first, in the
// event's category order, then last name, then first name. Names use the
// Polish locale so ą/ć/ł/ó/… sort correctly; this matches the printed start
// list, where bibs run in blocks per category.
//
// Categories carry no explicit sort field, and the categories API returns them
// by name, so the event's category order is the order they were created in
// (name breaks ties). Participants without a category go last.
export function sortParticipants(participants, categories) {
  const orderedCats = [...(categories || [])].sort((a, b) =>
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
    (a.name || '').localeCompare(b.name || '', 'pl', { sensitivity: 'base' })
  )
  const catRank = new Map(orderedCats.map((c, i) => [c.id, i]))
  const rank = (p) => catRank.get(p.categoryId) ?? orderedCats.length

  return [...(participants || [])].sort((a, b) =>
    rank(a) - rank(b) ||
    (a.lastName || '').localeCompare(b.lastName || '', 'pl', { sensitivity: 'base' }) ||
    (a.firstName || '').localeCompare(b.firstName || '', 'pl', { sensitivity: 'base' })
  )
}
