// The public start list (RA8 / RA8d) as display values, from the /api/startlist
// snapshot (start_list() in Supabase), and its filters. Pure, so the page and the
// unit tests call the same functions. No birth date, contact, bib or price ever
// reaches it: start_list() does not return them.
//
// An entry's category is its kids group in a kids competition, else its age group.
// The filters live in the page's state, never in the URL: a search names a person,
// and the address is what analytics sees.
//
// Ruling P3-R14: entries awaiting payment are never listed by person, only
// counted („+N czeka na wpłatę”), and a minor's town never arrives. An entry
// is 'paid' (money moved) or 'free' (nothing to pay: a free event or a 0 zł
// entry); only 'paid' reads „opłacone”. A free event never mentions payment.
//
// Ruling P3-R15: the limit counts paid entries only, so „N / limit” and the bar
// are paid + free; an entry awaiting payment holds no place and is only named
// beside them („+N czeka na wpłatę”).

import { countPl, pluralPl } from './plural.js'

const pct = (n, of) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0)

const paidText = (n) => countPl(n, ['opłacone', 'opłacone', 'opłaconych'])
const freeText = (n) => `${n} bez opłaty`
const awaitingText = (n) => `+${n} ${pluralPl(n, 'czeka', 'czekają', 'czeka')} na wpłatę`
const registeredText = (n) => countPl(n, ['osoba zapisana', 'osoby zapisane', 'osób zapisanych'])

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
    : registeredText(free + paid)
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
        taken: cPaid + cFree,
        capacity: c.capacity,
        paidPct,
        freePct,
        paidLabel: paidEvent && cPaid > 0 ? paidText(cPaid) : null,
        freeLabel: paidEvent && cFree > 0 ? freeText(cFree) : null,
        awaitingLabel: cAwaiting > 0 ? awaitingText(cAwaiting) : null,
      }
    }),
    entries: entries.map((e) => {
      const category = e.kidsGroupLabel ?? e.ageGroupLabel ?? null
      return {
        name: e.name,
        town: e.town ?? null,
        club: e.club ?? null,
        categoryId: e.categoryId,
        competition: e.competition,
        category,
        gender: e.gender ?? null,
        where: [e.town, e.club].filter(Boolean).join(' · '),
        what: [e.competition, category].filter(Boolean).join(' · '),
        badge: paidEvent && e.payment === 'paid' ? 'opłacone' : null,
      }
    }),
  }
}

/** „Bez klubu” in the club filter. */
export const NO_CLUB = '__none'

const collator = new Intl.Collator('pl-PL')

/** Lower case, no diacritics („Wiśniewska” → „wisniewska”, „Łoś” → „los”). */
export function foldPl(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

/**
 * The choices of RA8's selects, from the list itself: competitions in card order,
 * categories and clubs in Polish order, „Bez klubu” only when somebody has no club.
 * @param {ReturnType<typeof startListView>} view
 */
export function startListFilterOptions(view) {
  const entries = view?.entries ?? []
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort(collator.compare)
  const genders = new Set(entries.map((e) => e.gender))
  const clubs = uniq(entries.map((e) => e.club)).map((c) => ({ value: c, label: c }))
  if (entries.some((e) => !e.club)) clubs.push({ value: NO_CLUB, label: 'Bez klubu' })
  return {
    competitions: (view?.competitions ?? []).map((c) => ({ value: c.categoryId, label: c.name })),
    categories: uniq(entries.map((e) => e.category)),
    genders: [['K', 'Kobiety'], ['M', 'Mężczyźni']].filter(([g]) => genders.has(g)).map(([value, label]) => ({ value, label })),
    clubs,
  }
}

/**
 * The entries a viewer's filters keep, in start_list's order. Every empty filter
 * keeps everyone; `club` '__none' keeps those with no club; `q` matches name, town
 * and club, ignoring case and Polish diacritics. `total` is the whole list.
 * @param {ReturnType<typeof startListView>} view
 * @param {{ categoryId?: string, category?: string, gender?: string, club?: string, q?: string }} filters
 */
export function filterStartList(view, { categoryId = '', category = '', gender = '', club = '', q = '' } = {}) {
  const all = view?.entries ?? []
  const needle = foldPl(q)
  const entries = all.filter((e) =>
    (!categoryId || e.categoryId === categoryId)
    && (!category || e.category === category)
    && (!gender || e.gender === gender)
    && (!club || (club === NO_CLUB ? !e.club : e.club === club))
    && (!needle || [e.name, e.town, e.club].some((f) => f && foldPl(f).includes(needle))))
  return { entries, total: all.length }
}
