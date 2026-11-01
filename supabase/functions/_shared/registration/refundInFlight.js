// Which entries have a refund in flight (Plan 7, V-87 / M-1): a refund of one of their order lines
// that dpay has not settled (pending or unknown). The rule lives once, in SQL
// (registration_refund_in_flight, the check the transfer RPCs make); the read models ask
// registration_refunds_in_flight for a set of ids in one call. Runs on the admin client.

/** → Set of the ids among `ids` with a refund in flight. */
export async function refundsInFlight(admin, ids) {
  const list = [...new Set((ids ?? []).filter(Boolean))]
  if (list.length === 0) return new Set()
  const { data, error } = await admin.rpc('registration_refunds_in_flight', { p_registration_ids: list })
  if (error) throw error
  return new Set(data ?? [])
}
