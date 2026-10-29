// The public start list (RA8's columns, no filters yet) as display values,
// from the /api/startlist snapshot (start_list() in Supabase). Pure, so the
// page and the unit tests call the same function. No birth date, contact,
// bib or price ever reaches it: start_list() does not return them.
//
// Ruling P3-R14: entries awaiting payment are never listed by person, only
// counted („+N czeka na wpłatę”), and a minor's town never arrives. An entry
// is 'paid' (money moved) or 'free' (nothing to pay: a free event or a 0 zł
// entry); only 'paid' reads „opłacone”. A free event never mentions payment.

const pct = (n, of) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0)

const paidText = (n) => `${n} opłaconych`
const freeText = (n) => `${n} bez opłaty`
const awaitingText = (n) => `+${n} czeka na wpłatę`

/**
 * @param {object} snapshot the /api/startlist answer
 * @param {{ paidEvent: boolean }} opts paidEvent: the event's pricingMode is not 'free'
 */
export function startListView(snapshot, { paidEvent }) {
  const comps = snapshot?.competitions ?? []
  const entries = snapshot?.entries ?? []
  const sum = (k) => comps.reduce((n, c) => n + (c[k] ?? 0), 0)
  const paid = sum('paid')
  const free = sum('free')
  const awaiting = sum('awaiting')
  const header = paidEvent
    ? [paidText(paid), free > 0 ? freeText(free) : null, awaiting > 0 ? awaitingText(awaiting) : null].filter(Boolean).join(' · ')
    : `${free + paid} zapisanych`
  return {
    header,
    competitions: comps.map((c) => {
      const cPaid = c.paid ?? 0
      const cFree = c.free ?? 0
      const cAwaiting = c.awaiting ?? 0
      const paidPct = Math.min(100, pct(cPaid, c.capacity))
      const freePct = Math.min(100 - paidPct, pct(cFree, c.capacity))
      return {
        categoryId: c.categoryId,
        name: c.name,
        taken: cPaid + cFree + cAwaiting,
        capacity: c.capacity,
        paidPct,
        freePct,
        awaitingPct: Math.min(100 - paidPct - freePct, pct(cAwaiting, c.capacity)),
        paidLabel: paidEvent && cPaid > 0 ? paidText(cPaid) : null,
        freeLabel: paidEvent && cFree > 0 ? freeText(cFree) : null,
        awaitingLabel: cAwaiting > 0 ? awaitingText(cAwaiting) : null,
      }
    }),
    entries: entries.map((e) => ({
      name: e.name,
      where: [e.town, e.club].filter(Boolean).join(' · '),
      what: [e.competition, e.ageGroupLabel].filter(Boolean).join(' · '),
      badge: paidEvent && e.payment === 'paid' ? 'opłacone' : null,
    })),
  }
}
