/**
 * The order a session may act on as its buyer, or null (the caller answers 404).
 * A registration order belongs to its buyer_profile_id alone. A competition change's surcharge
 * whose buyer had no account (buyer_profile_id NULL, buyer_email set) is claimed by the first
 * session whose address equals buyer_email: one UPDATE ... WHERE buyer_profile_id IS NULL in
 * claim_surcharge_order. Anybody else gets null, exactly as for an unknown order.
 *
 * @param {*} admin service-role client
 * @param {string} orderId
 * @param {{ userId: string, email?: string|null }} session
 * @param {string} columns orders columns to return (must not be needed beyond the defaults)
 */
export async function orderForSession(admin, orderId, session, columns = 'id') {
  const select = `${columns}, buyer_profile_id, kind, buyer_email`
  const { data: order, error } = await admin.from('orders').select(select).eq('id', orderId).maybeSingle()
  if (error) throw error
  if (!order) return null
  if (order.buyer_profile_id === session.userId) return order
  if (order.buyer_profile_id !== null || order.kind !== 'surcharge') return null
  const email = (session.email ?? '').trim().toLowerCase()
  if (!email || (order.buyer_email ?? '').trim().toLowerCase() !== email) return null
  const { data: claimed, error: cErr } = await admin.rpc('claim_surcharge_order',
    { p_order_id: orderId, p_profile_id: session.userId, p_email: email })
  if (cErr) throw cErr
  if (claimed) return { ...order, buyer_profile_id: session.userId }
  // Lost the race: the order is now somebody's; it is ours only when we won it.
  const { data: now, error: nErr } = await admin.from('orders').select('buyer_profile_id').eq('id', orderId).maybeSingle()
  if (nErr) throw nErr
  return now?.buyer_profile_id === session.userId ? { ...order, buyer_profile_id: session.userId } : null
}
