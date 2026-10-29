// The public start list (RA8's columns, no filters yet) as display values,
// from the /api/startlist snapshot (start_list() in Supabase). Pure, so the
// page and the unit tests call the same function. No birth date, contact,
// bib or price ever reaches it: start_list() does not return them.

const pct = (n, of) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0)

const paidText = (n) => `${n} opłaconych`
const awaitingText = (n) => `${n} czeka na wpłatę`

export function startListView(snapshot) {
  const comps = snapshot?.competitions ?? []
  const entries = snapshot?.entries ?? []
  const paid = comps.reduce((n, c) => n + c.paid, 0)
  const awaiting = comps.reduce((n, c) => n + c.awaiting, 0)
  return {
    header: `${paidText(paid)} · ${awaitingText(awaiting)}`,
    paid,
    awaiting,
    competitions: comps.map((c) => {
      const paidPct = Math.min(100, pct(c.paid, c.capacity))
      return {
        categoryId: c.categoryId,
        name: c.name,
        taken: c.paid + c.awaiting,
        capacity: c.capacity,
        paidPct,
        awaitingPct: Math.min(100 - paidPct, pct(c.awaiting, c.capacity)),
        paidLabel: paidText(c.paid),
        awaitingLabel: c.awaiting > 0 ? awaitingText(c.awaiting) : null,
      }
    }),
    entries: entries.map((e) => ({
      name: e.name,
      where: [e.town, e.club].filter(Boolean).join(' · '),
      what: [e.competition, e.ageGroupLabel].filter(Boolean).join(' · '),
      paid: e.paid,
      badge: e.paid ? 'opłacone' : 'czeka na wpłatę',
    })),
  }
}
