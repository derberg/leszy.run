// The wizard's steps (spec §2): Podstawy · Biuro zawodów · Konkurencje ·
// Kategorie · Pomiar czasu · Formularz · Dodatki · Partnerzy · Płatności · Publikacja.
//
// wizardSteps({ pricingMode, hasPricedExtras, donationsEnabled, hasKidsCompetition, state: { checklist, current } })
//   → [{ key, label, available, done, kidsGroups? }]
// * Płatności is shown when the event collects money (D7-22): a pricing mode
//   other than free, a priced extra, or donations on (the caller passes
//   isCharity && donationsEnabled, ruling 7). takesMoney() in checklist.js is
//   the same rule for the publish checklist.
// * Every step is available. Dodatki is shown only while the money features are live (moneyLive).
// * Partnerzy is always shown, money or not (partners matter to free events too), and no checklist
//   item points at it: its edits apply at once (organizer-partners), nothing there blocks publishing.
// * `done`: a step before `current` that no checklist item points at. The
//   checklist is get-registration-event's publishChecklist(); blocking items
//   name a field, missing ones name their step.
// * Kategorie carries `kidsGroups`: „Grupy dzieci” is offered only when a
//   kids competition exists.

const STEPS = [
  { key: 'podstawy', label: 'Podstawy' },
  { key: 'biuro', label: 'Biuro zawodów' },
  { key: 'konkurencje', label: 'Konkurencje' },
  { key: 'kategorie', label: 'Kategorie' },
  { key: 'pomiar', label: 'Pomiar czasu' },
  { key: 'formularz', label: 'Formularz' },
  { key: 'dodatki', label: 'Dodatki' },
  { key: 'partnerzy', label: 'Partnerzy' },
  { key: 'platnosci', label: 'Płatności' },
  { key: 'publikacja', label: 'Publikacja' },
]

export const STEP_KEYS = STEPS.map((s) => s.key)

const BLOCKING_STEP = {
  name: 'podstawy',
  slug: 'podstawy',
  slug_taken: 'podstawy',
  event_date: 'podstawy',
  registration_dates: 'podstawy',
  place: 'podstawy',
  regulamin: 'podstawy',
  contact_email: 'podstawy',
  competitions: 'konkurencje',
  tiers: 'konkurencje',
  transfer_until: 'platnosci',
  extras_order_until: 'dodatki',
  payments: 'platnosci',
  payout: 'platnosci',
  agreement: 'publikacja',
}

/** The step that fixes a blocking checklist item. */
export function stepForBlocking(key) {
  if (key.startsWith('competition:')) return 'konkurencje'
  return BLOCKING_STEP[key] ?? 'publikacja'
}

export function wizardSteps({ pricingMode, hasPricedExtras = false, donationsEnabled = false, hasKidsCompetition, moneyLive = true, state = {} }) {
  const { checklist = { blocking: [], missing: [] }, current = null } = state
  const open = new Set([
    ...checklist.blocking.map((b) => stepForBlocking(b.key)),
    ...checklist.missing.map((m) => m.step),
  ])
  // With Plan 7's money features off (get-registration-event's moneyLive, flags.js), extras and
  // donations take no money and Dodatki is not offered (final review I-1 + I-4).
  const paidMode = pricingMode != null && pricingMode !== 'free'
  const money = paidMode || (moneyLive && (!!hasPricedExtras || !!donationsEnabled))
  const steps = STEPS.filter((s) => (s.key !== 'platnosci' || money) && (s.key !== 'dodatki' || moneyLive))
  const currentIndex = steps.findIndex((s) => s.key === current)

  return steps.map((s, i) => {
    const available = true
    const step = {
      ...s,
      available,
      done: available && s.key !== 'publikacja' && i < currentIndex && !open.has(s.key),
    }
    if (s.key === 'kategorie') step.kidsGroups = !!hasKidsCompetition
    return step
  })
}
