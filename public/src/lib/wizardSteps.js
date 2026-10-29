// The wizard's steps (spec §2): Podstawy · Biuro zawodów · Konkurencje ·
// Kategorie · Pomiar czasu · Formularz · Dodatki · Płatności · Publikacja.
//
// wizardSteps({ pricingMode, hasKidsCompetition, state: { checklist, current } })
//   → [{ key, label, available, done, kidsGroups? }]
// * Płatności is left out when the event is free (no money collected).
// * Dodatki is listed but never available yet.
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
  payments: 'platnosci',
  payout: 'platnosci',
  agreement: 'publikacja',
}

/** The step that fixes a blocking checklist item. */
export function stepForBlocking(key) {
  if (key.startsWith('competition:')) return 'konkurencje'
  return BLOCKING_STEP[key] ?? 'publikacja'
}

export function wizardSteps({ pricingMode, hasKidsCompetition, state = {} }) {
  const { checklist = { blocking: [], missing: [] }, current = null } = state
  const open = new Set([
    ...checklist.blocking.map((b) => stepForBlocking(b.key)),
    ...checklist.missing.map((m) => m.step),
  ])
  const steps = STEPS.filter((s) => s.key !== 'platnosci' || (pricingMode != null && pricingMode !== 'free'))
  const currentIndex = steps.findIndex((s) => s.key === current)

  return steps.map((s, i) => {
    const available = s.key !== 'dodatki'
    const step = {
      ...s,
      available,
      done: available && s.key !== 'publikacja' && i < currentIndex && !open.has(s.key),
    }
    if (s.key === 'kategorie') step.kidsGroups = !!hasKidsCompetition
    return step
  })
}
