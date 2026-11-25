import { formatPln } from '../../../supabase/functions/_shared/registration/money.js'

// „Moje zapisy” (/profil/zapisy): the links of one event's card, in menu order: one „Zamówienie” per
// order (its page), then „Twój zapis” (/zapisano) when an entry of the session's is confirmed. With
// several orders each link carries its total, so the labels tell them apart. Zapisy.jsx puts them in
// the one person's „⋯” (after the actions) or, with several people (or none), in the card header's.

/**
 * @param {{ slug: string|null, orders: Array<{ id: string, total: number }>, people: Array<{ status: string }> }} ev
 * @returns {Array<{ key: string, label: string, to: string, testId: string }>}
 */
export function cardLinks(ev) {
  const confirmed = ev.people.filter((p) => p.status === 'confirmed').length
  const several = ev.orders.length > 1
  return [
    ...ev.orders.map((o) => ({
      key: `order-${o.id}`, to: `/zamowienie/${o.id}`, testId: 'zapisy-order-link',
      label: several ? `Zamówienie · ${formatPln(o.total)}` : 'Zamówienie',
    })),
    ...(confirmed > 0 && ev.slug
      ? [{ key: 'entry', to: `/events/${ev.slug}/zapisano`, testId: 'zapisy-entry-link', label: confirmed > 1 ? 'Twoje zapisy' : 'Twój zapis' }]
      : []),
  ]
}

/** One person on the card: the links go in that person's menu; otherwise in the card header's. */
export function linksInPersonMenu(ev) {
  return ev.people.length === 1
}
