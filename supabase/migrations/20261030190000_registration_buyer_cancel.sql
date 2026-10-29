-- Race registration, plan 3 (P3-R15 re-review I1): the buyer cancels their own unpaid order.
--
-- Since P3-R15 a pending order holds no place, so the paid entries can fill its competition
-- while it waits. pay-order then refuses (full), and the runner was stuck: their live
-- pending_payment row keeps every new submit at 409 pending_order until the order expires,
-- which with „do końca zapisów” is when registration closes. The orphan sweep does not take
-- it, because it went to dpay once.
--
-- buyer_cancel_order is the one door the cancel-my-order edge function uses. Under the order
-- lock (the first lock of D3-1, the one confirm_order takes) it checks the buyer, that the order
-- is still pending, and that no attempt is paid, then cancels through cancel_order with reason
-- 'buyer_cancelled'. It never refunds: a pending order has no money. A payment still in flight at
-- dpay that lands afterwards finds a cancelled order and is refunded in full by confirm_order
-- (late_refund, reason 'cancelled'), exactly as for any other cancelled order.
--
-- → 'cancelled', or the refusal: 'not_found' (no such order, or somebody else's),
--   'paid' / 'expired' / 'cancelled_already', 'payment_received' (an attempt is paid).

CREATE FUNCTION public.buyer_cancel_order(p_order_id uuid, p_profile_id uuid) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  o public.orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR p_profile_id IS NULL OR o.buyer_profile_id IS DISTINCT FROM p_profile_id THEN
    RETURN 'not_found';
  END IF;
  IF o.status = 'cancelled' THEN
    RETURN 'cancelled_already';
  END IF;
  IF o.status <> 'pending' THEN
    RETURN o.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_attempts a WHERE a.order_id = o.id AND a.status <> 'created') THEN
    RETURN 'payment_received';
  END IF;
  IF NOT public.cancel_order(o.id, 'buyer_cancelled') THEN
    RETURN 'not_found';
  END IF;
  RETURN 'cancelled';
END $$;
REVOKE EXECUTE ON FUNCTION public.buyer_cancel_order(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buyer_cancel_order(uuid, uuid) TO service_role;
