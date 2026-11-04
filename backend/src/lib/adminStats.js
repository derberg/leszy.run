// Monthly growth figures for the admin "Statystyki" page, from raw Supabase
// rows. Pure, so the bucketing is tested without a database. Months are Warsaw
// calendar months: a sign-up at 00:30 on 1 November belongs to November.

const MONTH_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit' })

export function warsawMonth(ts) {
  if (!ts) return null
  return MONTH_FMT.format(new Date(ts)).slice(0, 7)
}

export function lastMonths(fromMonth, count) {
  let [y, m] = fromMonth.split('-').map(Number)
  const out = []
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
  }
  return out
}

const EMPTY = {
  users: 0, onboarded: 0, clubs: 0, clubJoins: 0, favorites: 0,
  registrationEvents: 0, registrations: 0, paidOrders: 0, paidAmount: 0,
}

/**
 * @param {object} raw rows: profiles, clubs, clubMembers, favorites,
 *   registrationEvents (registration_settings), registrations, orders
 * @param {{ now?: string|Date, months?: number }} opts
 */
export function buildAdminStats(raw, { now = new Date(), months = 12 } = {}) {
  const keys = lastMonths(warsawMonth(now), months)
  const byMonth = new Map(keys.map((k) => [k, { month: k, ...EMPTY }]))
  const add = (ts, field, by = 1) => {
    const row = byMonth.get(warsawMonth(ts))
    if (row) row[field] += by
  }

  for (const p of raw.profiles) {
    add(p.created_at, 'users')
    if (p.username) add(p.created_at, 'onboarded')
  }
  for (const c of raw.clubs) add(c.created_at, 'clubs')
  // A founder becomes the owner when the club is created; that is not a join.
  for (const m of raw.clubMembers) if (m.role !== 'owner') add(m.joined_at, 'clubJoins')
  for (const f of raw.favorites) add(f.created_at, 'favorites')
  for (const e of raw.registrationEvents) add(e.published_at, 'registrationEvents')
  for (const r of raw.registrations) if (r.status === 'confirmed') add(r.created_at, 'registrations')
  for (const o of raw.orders) {
    if (!o.paid_at) continue
    add(o.paid_at, 'paidOrders')
    add(o.paid_at, 'paidAmount', o.total ?? 0)
  }

  const live = raw.profiles.filter((p) => !p.deleted_at)
  const paid = raw.orders.filter((o) => o.paid_at)
  const totals = {
    users: live.length,
    onboarded: live.filter((p) => p.username).length,
    clubs: raw.clubs.length,
    clubMembers: raw.clubMembers.filter((m) => m.status === 'active').length,
    favorites: raw.favorites.length,
    registrationEvents: raw.registrationEvents.filter((e) => e.published_at).length,
    registrations: raw.registrations.filter((r) => r.status === 'confirmed').length,
    paidOrders: paid.length,
    paidAmount: paid.reduce((s, o) => s + (o.total ?? 0), 0),
  }

  return { totals, months: keys.map((k) => byMonth.get(k)) }
}
