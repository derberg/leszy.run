// The organizer's extras list (dodatki): what to hand out at the bib office, who still owes money
// for theirs, and how many of each variant to prepare. Pure rows in, plain data out. Plain ESM:
// runs in Deno, Node and the browser. Counts UNITS (qty), never lines.

const AWAITING = 'pending_payment'

/** Units of a line still to hand out: qty less the units whose price came back. */
export function handoutUnits(line) {
  const qty = Number(line.qty) || 0
  if (qty <= 0) return 0
  const amount = Number(line.amount) || 0
  if (amount <= 0) return qty
  const unit = amount / qty
  return Math.max(0, qty - Math.floor((Number(line.refunded) || 0) / unit))
}

/**
 * `Koszulka L ×2, Medal`: name and variant, `×n` only above 1, ` (zwrócono)` on a fully refunded line.
 * @param {{ name, variant, qty, amount, refunded }[]} extras
 */
export function extrasText(extras) {
  return (extras ?? []).map((e) => {
    const label = [e.name, e.variant].filter(Boolean).join(' ')
    const times = e.qty > 1 ? ` ×${e.qty}` : ''
    return `${label}${times}${handoutUnits(e) === 0 ? ' (zwrócono)' : ''}`
  }).join(', ')
}

const byPerson = (a, b) => {
  if ((a.bib == null) !== (b.bib == null)) return a.bib == null ? 1 : -1
  if (a.bib != null && a.bib !== b.bib) return a.bib - b.bib
  return String(a.lastName ?? '').localeCompare(String(b.lastName ?? ''), 'pl')
    || String(a.firstName ?? '').localeCompare(String(b.firstName ?? ''), 'pl')
}

/**
 * @param {object[]} rows the panel's rows (with `extras`, `withdrawn`)
 * @param {{ extraId?: string }} [opts] narrows people AND lines to one extra
 * @returns {{ handout: object[], awaiting: object[], totals: { extraId, extra, variantId, variant, count }[] }}
 */
export function extrasList(rows, { extraId } = {}) {
  const handout = []
  const awaiting = []
  const totals = new Map()
  let seen = 0
  for (const row of rows) {
    const waiting = row.status === AWAITING && row.statusKey !== 'expired' && !row.withdrawn
    const give = row.status === 'confirmed' && row.withdrawn === false
    if (!waiting && !give) continue
    for (const e of row.extras ?? []) {
      if (extraId && e.extraId !== extraId) continue
      const units = waiting ? e.qty : handoutUnits(e)
      if (units <= 0) continue
      const item = {
        bib: row.bib ?? null, firstName: row.firstName, lastName: row.lastName, name: row.name,
        competition: row.competition, team: row.team ?? null, extra: e.name, variant: e.variant ?? null, qty: units,
        // grosze of the kept units: what was paid less what came back (an awaiting line: its price)
        paid: waiting ? e.amount : Math.max(0, e.amount - (e.refunded ?? 0)),
        email: row.role === 'minor' ? row.guardianEmail ?? null : row.email ?? null,
        phone: row.phone ?? null,
      }
      if (waiting) { awaiting.push(item); continue }
      handout.push(item)
      const key = `${e.extraId}\u0000${e.variantId ?? ''}`
      const t = totals.get(key) ?? { extraId: e.extraId, extra: e.name, variantId: e.variantId ?? null, variant: e.variant ?? null, count: 0, seen: seen++, extraOrder: e.extraOrder, variantOrder: e.variantOrder }
      t.count += units
      totals.set(key, t)
    }
  }
  handout.sort(byPerson)
  awaiting.sort(byPerson)
  const ordered = (t) => Number.isFinite(t.extraOrder) && Number.isFinite(t.variantOrder)
  const list = [...totals.values()].sort((a, b) => (ordered(a) && ordered(b)
    ? a.extraOrder - b.extraOrder || a.variantOrder - b.variantOrder
    : 0) || a.seen - b.seen)
  return { handout, awaiting, totals: list.map(({ seen: _s, extraOrder: _e, variantOrder: _v, ...t }) => t) }
}
