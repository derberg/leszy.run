// Who provided an added adult's data (Art. 14(2)(f) / 15(1)(g)): one rule for the consent e-mail
// (consentRequests.js) and the person's own export (export-my-data), final review I-2. The
// organizer view (list-event-registrations) applies the same order to rows it has already read.
// Runs on the admin (service role) client; never returns an address or an account id.

async function rows(query) {
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

const LIVE = ['confirmed', 'pending_payment']

/**
 * → (registration) → name | null, in this order: the name the buyer typed for the
 * registration's order (m-1), the buyer's own live entry in the event (the latest one), the
 * guardian name their children carry, the account's display name. A free group has no order,
 * so it starts at the second. A deleted account names nobody: delete-my-account nulls
 * registered_by_profile_id and the order's buyer_name, and its display name is left out.
 * Cancelled and expired entries are not read (m-6).
 * `regs` carry event_id, order_id and registered_by_profile_id.
 */
export async function registeredByNames(admin, regs) {
  const ids = [...new Set(regs.map((r) => r.registered_by_profile_id).filter(Boolean))]
  const orderIds = [...new Set(regs.map((r) => r.order_id).filter(Boolean))]
  const events = [...new Set(regs.map((r) => r.event_id))]
  const [orders, own, kids, profiles] = await Promise.all([
    orderIds.length ? rows(admin.from('orders').select('id, buyer_name').in('id', orderIds)) : [],
    ids.length
      ? rows(admin.from('registrations').select('profile_id, first_name, last_name')
        .in('event_id', events).in('profile_id', ids).in('status', LIVE)
        .order('created_at', { ascending: false }).order('id'))
      : [],
    ids.length
      ? rows(admin.from('registrations').select('guardian_profile_id, guardian_name')
        .in('event_id', events).in('guardian_profile_id', ids).in('status', LIVE)
        .not('guardian_name', 'is', null).order('created_at', { ascending: false }).order('id'))
      : [],
    ids.length ? rows(admin.from('profiles').select('id, display_name').in('id', ids).is('deleted_at', null)) : [],
  ])
  const byOrder = new Map(orders.filter((o) => o.buyer_name?.trim()).map((o) => [o.id, o.buyer_name.trim()]))
  const byProfile = new Map()
  // Lowest precedence first; a later set overrides. Within a list the first row (the latest) wins.
  for (const p of profiles) if (p.display_name?.trim()) byProfile.set(p.id, p.display_name.trim())
  const firstOf = (list, key, name) => {
    const seen = new Set()
    for (const x of list) {
      const n = name(x)
      if (!n || seen.has(x[key])) continue
      seen.add(x[key])
      byProfile.set(x[key], n)
    }
  }
  firstOf(kids, 'guardian_profile_id', (k) => k.guardian_name?.trim())
  firstOf(own, 'profile_id', (o) => `${o.first_name ?? ''} ${o.last_name ?? ''}`.trim())
  return (r) => byOrder.get(r.order_id) ?? byProfile.get(r.registered_by_profile_id) ?? null
}
